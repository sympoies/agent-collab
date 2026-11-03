// Read-only MessageSource spike over a user-selected File System Access handle.

import { SourceError, type DirectoryEntry, type Head, type MessageSource } from "./types";

/** The small structural surface needed by native handles and in-memory tests. */
export interface LocalHandle {
  readonly kind: string;
  readonly name: string;
  getFile?(): Promise<Blob & { readonly lastModified: number }>;
  values?(): AsyncIterable<LocalHandle>;
  getDirectoryHandle?(name: string): Promise<LocalDirectoryHandle>;
  getFileHandle?(name: string): Promise<LocalFileHandle>;
}

export interface LocalDirectoryHandle extends LocalHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<LocalHandle>;
  getDirectoryHandle(name: string): Promise<LocalDirectoryHandle>;
  getFileHandle(name: string): Promise<LocalFileHandle>;
  queryPermission?(descriptor?: { readonly mode: "read" }): Promise<PermissionState>;
}

export interface LocalFileHandle extends LocalHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<Blob & { readonly lastModified: number }>;
}

const MAX_FILE_BYTES = 1024 * 1024;
const METADATA_CONCURRENCY = 6;

async function mapLimit<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>) {
  const results: R[] = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await fn(values[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function createLimiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

function safeSegment(segment: string): boolean {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\")
  ) {
    return false;
  }
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function stableId(kind: string, value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${kind}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isDirectoryHandle(handle: LocalHandle): handle is LocalDirectoryHandle {
  return (
    handle.kind === "directory" &&
    typeof handle.values === "function" &&
    typeof handle.getDirectoryHandle === "function" &&
    typeof handle.getFileHandle === "function"
  );
}

function isFileHandle(handle: LocalHandle): handle is LocalFileHandle {
  return handle.kind === "file" && typeof handle.getFile === "function";
}

function validRepoPath(path: string): boolean {
  if (path === "") return true;
  const segments = path.split("/");
  if (segments.some((segment) => !safeSegment(segment))) return false;
  return segments[0] === ".agent-collab" || segments[0] === "inbox" || segments[0] === "topics";
}

function errorFor(path: string, error: unknown): SourceError {
  const name =
    typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
      ? error.name
      : "";
  if (name === "NotFoundError") return new SourceError("not-found", path);
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new SourceError(
      "forbidden",
      path,
      null,
      null,
      "Local folder permission is unavailable.",
    );
  }
  return new SourceError("unexpected", path);
}

export class LocalFolderSource implements MessageSource {
  private revision = 0;
  private readonly metadataFailures = new Map<string, SourceError>();

  constructor(private readonly root: LocalDirectoryHandle) {}

  async head(previous: Head | null): Promise<Head> {
    try {
      const permission = await this.root.queryPermission?.({ mode: "read" });
      if (permission !== undefined && permission !== "granted") {
        throw new SourceError(
          "forbidden",
          "",
          null,
          null,
          "Local folder permission needs to be granted again.",
        );
      }
      this.revision += 1;
      return {
        revision: `local-${this.revision}-${previous === null ? "initial" : "next"}`,
        validator: null,
      };
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw errorFor("", error);
    }
  }

  async listDirectory(_revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    if (!validRepoPath(path)) throw new SourceError("forbidden", path);
    try {
      const directory = await this.directoryAt(path);
      const handles: Array<{
        readonly handle: LocalHandle;
        readonly path: string;
      }> = [];
      for await (const handle of directory.values()) {
        if (!safeSegment(handle.name)) continue;
        const entryPath = path === "" ? handle.name : `${path}/${handle.name}`;
        if (!validRepoPath(entryPath)) continue;
        handles.push({ handle, path: entryPath });
      }
      const withMetadata = createLimiter(METADATA_CONCURRENCY);
      const entries = await mapLimit(
        handles,
        METADATA_CONCURRENCY,
        async ({ handle, path: entryPath }) => {
          if (isDirectoryHandle(handle)) {
            const objectId = await this.directoryId(handle, entryPath, withMetadata);
            return {
              name: handle.name,
              path: entryPath,
              kind: "directory" as const,
              objectId,
            };
          }
          if (isFileHandle(handle)) {
            return {
              name: handle.name,
              path: entryPath,
              kind: "file" as const,
              objectId: await this.fileObjectId(entryPath, handle, withMetadata),
            };
          }
          // Unknown kinds, including symlink-like entries, are never followed.
          return null;
        },
      );
      return entries.filter((entry) => entry !== null);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw errorFor(path, error);
    }
  }

  async readFile(entry: DirectoryEntry): Promise<string> {
    if (entry.kind !== "file" || !validRepoPath(entry.path)) {
      throw new SourceError("forbidden", entry.path);
    }
    const metadataFailure = this.metadataFailures.get(entry.path);
    if (metadataFailure !== undefined) {
      this.metadataFailures.delete(entry.path);
      throw metadataFailure;
    }
    try {
      const handle = await this.fileAt(entry.path);
      const file = await handle.getFile();
      if (file.size > MAX_FILE_BYTES) throw new SourceError("too-large", entry.path);
      return await file.text();
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw errorFor(entry.path, error);
    }
  }

  rateLimit(): null {
    return null;
  }

  private async directoryAt(path: string): Promise<LocalDirectoryHandle> {
    let current = this.root;
    for (const segment of path === "" ? [] : path.split("/")) {
      current = await current.getDirectoryHandle(segment);
    }
    return current;
  }

  private async fileAt(path: string): Promise<LocalFileHandle> {
    const segments = path.split("/");
    const name = segments.pop();
    if (name === undefined) throw new SourceError("forbidden", path);
    const parent = await this.directoryAt(segments.join("/"));
    return parent.getFileHandle(name);
  }

  private async directoryId(
    directory: LocalDirectoryHandle,
    path: string,
    withMetadata: <T>(task: () => Promise<T>) => Promise<T>,
  ): Promise<string> {
    const handles: LocalHandle[] = [];
    for await (const child of directory.values()) {
      if (!safeSegment(child.name)) continue;
      if (isFileHandle(child) || isDirectoryHandle(child)) handles.push(child);
    }
    const children = await mapLimit(handles, METADATA_CONCURRENCY, async (child) => {
      if (isFileHandle(child)) {
        const childPath = `${path}/${child.name}`;
        return `file:${child.name}:${await this.fileObjectId(childPath, child, withMetadata)}`;
      }
      // The child directory is listed independently when its contents are needed.
      return `directory:${child.name}`;
    });
    children.sort();
    return stableId("directory", children.join("\n"));
  }

  private async fileObjectId(
    path: string,
    handle: LocalFileHandle,
    withMetadata: <T>(task: () => Promise<T>) => Promise<T>,
  ): Promise<string> {
    this.metadataFailures.delete(path);
    try {
      const file = await withMetadata(() => handle.getFile());
      return stableId("file", `${file.size}:${file.lastModified}`);
    } catch (error) {
      const mapped = errorFor(path, error);
      const safeError =
        mapped.kind === "forbidden"
          ? new SourceError("unexpected", path, null, null, "Local file metadata is unavailable.")
          : mapped;
      this.metadataFailures.set(path, safeError);
      return stableId("unavailable", `${path}:${safeError.kind}`);
    }
  }
}

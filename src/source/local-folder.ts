// Read-only MessageSource over a user-selected File System Access handle. A poll makes one scan
// of the collaboration files (docs/design/local-source.md) and answers "not modified" when nothing
// changed, so an unchanged folder republishes nothing.

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

export const MAX_FILE_BYTES = 1024 * 1024;
/** Entries a scan or listing may enumerate before the folder counts as too large. */
export const MAX_SCAN_ENTRIES = 50_000;
/** A modification time later than now plus this is clock skew or a hostile file, not a change. */
export const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MONTH_RE = /^\d{4}-\d{2}$/;
export const TOO_LARGE = "This folder is too large to read. Choose the clone folder itself.";
const METADATA_CONCURRENCY = 6;
const TOPIC_FOLDER_RE = /^topics\/[^/]+$/;
const TOPIC_INBOX_RE = /^topics\/[^/]+\/inbox$/;

/** The directories a scan walks: the inbox and its months, `topics`, and each topic's inbox. */
function isScannedPath(path: string, name: string, parent: string): boolean {
  if (path === "inbox" || path === "topics") return true;
  if (parent === "inbox" || TOPIC_INBOX_RE.test(parent)) return MONTH_RE.test(name);
  if (parent === "topics") return true;
  return TOPIC_FOLDER_RE.test(parent) && name === "inbox";
}

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

/** A 53-bit string hash (cyrb53): a collision, which would hide a change, is very unlikely. */
export function stableId(kind: string, value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${kind}-${hash.toString(16).padStart(14, "0")}`;
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
      "local-permission",
    );
  }
  return new SourceError("unexpected", path);
}

interface Scan {
  readonly revision: string;
  /** Listings of the root, the inbox and every inbox directory, read once per scan. */
  readonly listings: ReadonlyMap<string, readonly DirectoryEntry[]>;
  readonly lastChanged: Date | null;
  readonly lastChangedPath: string | null;
}

function directoryIdOf(entries: readonly DirectoryEntry[]): string {
  return stableId(
    "directory",
    entries
      .map((entry) => `${entry.kind}:${entry.name}:${entry.objectId}`)
      .sort()
      .join("\n"),
  );
}

export class LocalFolderSource implements MessageSource {
  private readonly metadataFailures = new Map<string, SourceError>();
  private scan: Scan | null = null;

  private scanning: Promise<Scan> | null = null;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(
    private readonly root: LocalDirectoryHandle,
    options: { readonly now?: () => number; readonly maxEntries?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? MAX_SCAN_ENTRIES;
  }

  /** The file with the newest modification time in the latest scan; the greatest path on a tie. */
  lastChangedPath(): string | null {
    return this.scan?.lastChangedPath ?? null;
  }

  /** The newest modification time seen by the latest successful scan. */
  lastChanged(): Date | null {
    return this.scan?.lastChanged ?? null;
  }

  async head(previous: Head | null): Promise<Head | "not-modified"> {
    try {
      const permission = await this.root.queryPermission?.({ mode: "read" });
      if (permission !== undefined && permission !== "granted") {
        throw new SourceError(
          "forbidden",
          "",
          null,
          null,
          "Local folder permission needs to be granted again. Choose the folder again from the toolbar.",
          "local-permission",
        );
      }
      // A poll that arrives while a scan is still running shares it instead of starting another.
      this.scanning ??= this.scanTree().finally(() => {
        this.scanning = null;
      });
      const scan = await this.scanning;
      this.scan = scan;
      if (previous?.validator === scan.revision) return "not-modified";
      return { revision: scan.revision, validator: scan.revision };
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw errorFor("", error);
    }
  }

  /**
   * One walk of the collaboration files: every inbox directory is listed once and every file's
   * metadata read once. The revision covers all of it, so any edit, addition or removal changes
   * it. Only the inbox, `topics/<topic>/inbox` and their month folders are walked, and at most
   * `maxEntries` entries are enumerated, so a hostile clone fails fast instead of hanging. Other
   * topic files are not part of the scan; they are read when a card is opened.
   */
  private async scanTree(): Promise<Scan> {
    const listings = new Map<string, readonly DirectoryEntry[]>();
    const withMetadata = createLimiter(METADATA_CONCURRENCY);
    const seen: { newest: number | null; newestPath: string | null; entries: number } = {
      newest: null,
      newestPath: null,
      entries: 0,
    };
    const latestTrusted = this.now() + FUTURE_SKEW_MS;

    const scanDirectory = async (
      directory: LocalDirectoryHandle,
      path: string,
    ): Promise<readonly DirectoryEntry[]> => {
      const handles: LocalHandle[] = [];
      for await (const handle of directory.values()) {
        seen.entries += 1;
        if (seen.entries > this.maxEntries)
          throw new SourceError("too-large", path, null, null, TOO_LARGE);
        if (!safeSegment(handle.name)) continue;
        const entryPath = path === "" ? handle.name : `${path}/${handle.name}`;
        if (validRepoPath(entryPath)) handles.push(handle);
      }
      // A topic folder is walked only for its inbox; the entry budget bounds the topic count.
      const topicFolder = TOPIC_FOLDER_RE.test(path);
      const entries = await mapLimit(handles, METADATA_CONCURRENCY, async (handle) => {
        const entryPath = path === "" ? handle.name : `${path}/${handle.name}`;
        // Topic files outside the inbox (the notes, attachments) are read on demand.
        if (topicFolder && !(handle.name === "inbox" && isDirectoryHandle(handle))) return null;
        if (isFileHandle(handle)) {
          const meta = await this.fileMetadata(entryPath, handle, withMetadata);
          if (
            meta.modified !== null &&
            meta.modified <= latestTrusted &&
            (seen.newest === null ||
              meta.modified > seen.newest ||
              (meta.modified === seen.newest && entryPath > (seen.newestPath ?? "")))
          ) {
            seen.newest = meta.modified;
            seen.newestPath = entryPath;
          }
          return {
            name: handle.name,
            path: entryPath,
            kind: "file" as const,
            objectId: meta.objectId,
            ...(meta.size === null ? {} : { size: meta.size }),
          };
        }
        if (isDirectoryHandle(handle)) {
          // The inbox, its month folders and, in the topic layout, the same under every topic are
          // walked; anything deeper is listed on demand.
          const scanned = isScannedPath(entryPath, handle.name, path);
          const children = scanned ? await scanDirectory(handle, entryPath) : null;
          return {
            name: handle.name,
            path: entryPath,
            kind: "directory" as const,
            objectId:
              children === null ? stableId("directory", entryPath) : directoryIdOf(children),
          };
        }
        // Unknown kinds, including symlink-like entries, are never followed.
        return null;
      });
      const listed = entries.filter((entry) => entry !== null);
      // A topic folder's own listing is partial (its inbox only), so it is read on demand.
      if (!topicFolder) listings.set(path, listed);
      return listed;
    };

    const rootEntries = await scanDirectory(this.root, "");
    return {
      revision: stableId("scan", directoryIdOf(rootEntries)),
      listings,
      lastChanged: seen.newest === null ? null : new Date(seen.newest),
      lastChangedPath: seen.newestPath,
    };
  }

  async listDirectory(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    if (!validRepoPath(path)) throw new SourceError("forbidden", path);
    // The scan of this revision already holds the listing: no second metadata walk.
    const cached = this.scan?.revision === revision ? this.scan.listings.get(path) : undefined;
    if (cached !== undefined) return cached;
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
        if (handles.length > this.maxEntries) {
          throw new SourceError("too-large", path, null, null, TOO_LARGE);
        }
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
            const meta = await this.fileMetadata(entryPath, handle, withMetadata);
            return {
              name: handle.name,
              path: entryPath,
              kind: "file" as const,
              objectId: meta.objectId,
              ...(meta.size === null ? {} : { size: meta.size }),
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
    return (await this.fileMetadata(path, handle, withMetadata)).objectId;
  }

  private async fileMetadata(
    path: string,
    handle: LocalFileHandle,
    withMetadata: <T>(task: () => Promise<T>) => Promise<T>,
  ): Promise<{ objectId: string; size: number | null; modified: number | null }> {
    this.metadataFailures.delete(path);
    try {
      const file = await withMetadata(() => handle.getFile());
      return {
        objectId: stableId("file", `${file.size}:${file.lastModified}`),
        size: file.size,
        modified: file.lastModified,
      };
    } catch (error) {
      const mapped = errorFor(path, error);
      const safeError =
        mapped.kind === "forbidden"
          ? new SourceError("unexpected", path, null, null, "Local file metadata is unavailable.")
          : mapped;
      this.metadataFailures.set(path, safeError);
      return {
        objectId: stableId("unavailable", `${path}:${safeError.kind}`),
        size: null,
        modified: null,
      };
    }
  }
}

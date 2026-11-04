import {
  FUTURE_SKEW_MS,
  MAX_FILE_BYTES,
  MAX_SCAN_ENTRIES,
  TOO_LARGE,
  stableId,
} from "./local-folder";
import { SourceError, type DirectoryEntry, type Head, type MessageSource } from "./types";

export const MAX_FOLDER_BYTES = 50 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

interface FolderDropEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  file?(success: (file: File) => void, failure?: (error: DOMException) => void): void;
  createReader?(): {
    readEntries(
      success: (entries: FolderDropEntry[]) => void,
      failure?: (error: DOMException) => void,
    ): void;
  };
}

/** Reads a dropped folder with the same exclusions and bounds as a directory input snapshot. */
export async function filesFromFolderDrop(
  dataTransfer: DataTransfer,
  options: { readonly maxEntries?: number; readonly maxBytes?: number } = {},
): Promise<readonly File[]> {
  const maxEntries = options.maxEntries ?? MAX_SCAN_ENTRIES;
  const maxBytes = options.maxBytes ?? MAX_FOLDER_BYTES;
  const roots: FolderDropEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    const dropItem = item as DataTransferItem & {
      webkitGetAsEntry?: () => FolderDropEntry | null;
    };
    if (typeof dropItem.webkitGetAsEntry !== "function") continue;
    const entry = dropItem.webkitGetAsEntry.call(dropItem);
    if (entry !== null) roots.push(entry);
  }
  if (roots.length === 0) return copyDropFileList(dataTransfer.files, maxEntries, maxBytes);

  let entries = 0;
  let bytes = 0;
  const files: File[] = [];

  const readEntry = (entry: FolderDropEntry): Promise<File | null> =>
    new Promise((resolve, reject) => {
      entry.file?.(resolve, reject);
    });

  const readBatch = (
    reader: ReturnType<NonNullable<FolderDropEntry["createReader"]>>,
  ): Promise<FolderDropEntry[]> =>
    new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });

  const walk = async (entry: FolderDropEntry, parent: string): Promise<void> => {
    if (!safeSegment(entry.name)) throw new SourceError("forbidden", "");
    // Ignore these directories before opening a reader or requesting any file objects.
    if (entry.isDirectory && IGNORED_DIRECTORIES.has(entry.name)) return;

    const path = parent === "" ? entry.name : `${parent}/${entry.name}`;
    if (!safeRelativePath(path)) throw new SourceError("forbidden", "");
    entries += 1;
    if (entries > maxEntries) throw new SourceError("too-large", "", null, null, TOO_LARGE);

    if (entry.isFile) {
      if (entry.file === undefined) return;
      const file = await readEntry(entry);
      if (file === null) return;
      const rootSlash = path.indexOf("/");
      const repoPath = rootSlash === -1 ? "" : path.slice(rootSlash + 1);
      if (validRepoPath(repoPath) && file.size > MAX_FILE_BYTES) {
        throw new SourceError("too-large", path);
      }
      bytes += file.size;
      if (bytes > maxBytes) throw new SourceError("too-large", "", null, null, TOO_LARGE);
      Object.defineProperty(file, "webkitRelativePath", { value: path });
      files.push(file);
      return;
    }

    if (!entry.isDirectory || entry.createReader === undefined) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await readBatch(reader);
      if (batch.length === 0) return;
      for (const child of batch) await walk(child, path);
    }
  };

  for (const root of roots) await walk(root, "");
  return files;
}

function copyDropFileList(files: FileList, maxEntries: number, maxBytes: number): File[] {
  const selected: File[] = [];
  let bytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file === undefined) continue;
    const relative = file.webkitRelativePath;
    if (relative !== "" && !safeRelativePath(relative)) throw new SourceError("forbidden", "");
    const segments = pathSegments(relative);
    if (segments.slice(1, -1).some((segment) => IGNORED_DIRECTORIES.has(segment))) continue;
    selected.push(file);
    if (selected.length > maxEntries) {
      throw new SourceError("too-large", "", null, null, TOO_LARGE);
    }
    bytes += file.size;
    if (bytes > maxBytes) throw new SourceError("too-large", "", null, null, TOO_LARGE);
  }
  return selected;
}

interface SnapshotFile {
  readonly file: File;
  readonly entry: DirectoryEntry;
}

interface SnapshotDirectory {
  readonly path: string;
  readonly children: Map<string, SnapshotDirectory | SnapshotFile>;
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

function safeRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\\")) {
    return false;
  }
  return path.split("/").every(safeSegment);
}

function validRepoPath(path: string): boolean {
  if (!safeRelativePath(path)) return false;
  const top = path.split("/", 1)[0];
  return top === ".agent-collab" || top === "inbox" || top === "topics";
}

function pathSegments(path: string): string[] {
  return path === "" ? [] : path.split("/");
}

/** A read-only snapshot backed by the File objects from a directory input or folder drop. */
export class FileListFolderSource implements MessageSource {
  private readonly root: SnapshotDirectory = { path: "", children: new Map() };
  private readonly files = new Map<string, SnapshotFile>();
  private readonly text = new Map<string, Promise<string>>();
  private readonly revision: string;
  private readonly changed: Date | null;

  constructor(
    files: readonly File[] | FileList,
    options: { readonly maxFiles?: number; readonly maxBytes?: number } = {},
  ) {
    const maxFiles = options.maxFiles ?? MAX_SCAN_ENTRIES;
    const maxBytes = options.maxBytes ?? MAX_FOLDER_BYTES;
    const seen = new Set<string>();
    const firstSegments = new Set<string>();
    const selected: Array<{ file: File; path: string }> = [];
    let fileCount = 0;
    let bytes = 0;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (file === undefined) continue;
      const relative = (file as File & { readonly webkitRelativePath?: string }).webkitRelativePath;
      if (typeof relative !== "string" || !safeRelativePath(relative)) {
        throw new SourceError("forbidden", "");
      }
      const segments = pathSegments(relative);
      if (segments.length < 2) throw new SourceError("forbidden", "");
      firstSegments.add(segments[0] ?? "");
      if (firstSegments.size > 1) throw new SourceError("forbidden", "");
      const path = segments.slice(1).join("/");
      if (!safeRelativePath(path)) throw new SourceError("forbidden", "");
      if (seen.has(path)) throw new SourceError("forbidden", path);
      seen.add(path);

      // Skip repository metadata and dependency/build folders before counting or inspecting size.
      if (segments.slice(1, -1).some((segment) => IGNORED_DIRECTORIES.has(segment))) continue;
      fileCount += 1;
      bytes += file.size;
      if (fileCount > maxFiles || bytes > maxBytes) {
        throw new SourceError("too-large", "", null, null, TOO_LARGE);
      }
      if (!validRepoPath(path)) continue;
      selected.push({ file, path });
    }

    let newest: number | null = null;
    const latestTrusted = Date.now() + FUTURE_SKEW_MS;
    for (const { file, path } of selected) {
      if (file.size > MAX_FILE_BYTES) throw new SourceError("too-large", path);
      const segments = pathSegments(path);
      let directory = this.root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index] as string;
        const childPath = segments.slice(0, index + 1).join("/");
        let child = directory.children.get(name);
        if (child === undefined) {
          child = { path: childPath, children: new Map() };
          directory.children.set(name, child);
        }
        if (!("children" in child)) throw new SourceError("forbidden", path);
        directory = child;
      }
      const name = segments.at(-1);
      if (name === undefined) throw new SourceError("forbidden", path);
      const entry: DirectoryEntry = {
        name,
        path,
        kind: "file",
        objectId: stableId("file", `${path}:${file.size}:${file.lastModified}`),
        size: file.size,
      };
      const snapshot = { file, entry };
      directory.children.set(name, snapshot);
      this.files.set(path, snapshot);
      if (
        Number.isFinite(file.lastModified) &&
        file.lastModified <= latestTrusted &&
        (newest === null || file.lastModified > newest)
      ) {
        newest = file.lastModified;
      }
    }

    this.revision = stableId(
      "snapshot",
      [...this.files.values()]
        .map(({ entry }) => `${entry.path}:${entry.size}:${entry.objectId}`)
        .sort()
        .join("\n"),
    );
    this.changed = newest === null ? null : new Date(newest);
  }

  lastChanged(): Date | null {
    return this.changed;
  }

  head(previous: Head | null): Promise<Head | "not-modified"> {
    return Promise.resolve(
      previous?.validator === this.revision
        ? "not-modified"
        : { revision: this.revision, validator: this.revision },
    );
  }

  listDirectory(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    return Promise.resolve().then(() => {
      if (revision !== this.revision || (path !== "" && !safeRelativePath(path))) {
        throw new SourceError("forbidden", path);
      }
      let directory = this.root;
      for (const segment of pathSegments(path)) {
        const child = directory.children.get(segment);
        if (child === undefined || !("children" in child)) throw new SourceError("not-found", path);
        directory = child;
      }
      return [...directory.children.entries()]
        .map(([name, child]) => {
          if ("children" in child) {
            const children = [...child.children.values()]
              .map((entry) => ("entry" in entry ? entry.entry.objectId : `directory:${entry.path}`))
              .sort()
              .join("\n");
            return {
              name,
              path: child.path,
              kind: "directory" as const,
              objectId: stableId("directory", children),
            };
          }
          return child.entry;
        })
        .sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  async readFile(entry: DirectoryEntry): Promise<string> {
    if (entry.kind !== "file" || !safeRelativePath(entry.path)) {
      throw new SourceError("forbidden", entry.path);
    }
    const snapshot = this.files.get(entry.path);
    if (snapshot === undefined || snapshot.entry.objectId !== entry.objectId) {
      throw new SourceError("not-found", entry.path);
    }
    if (snapshot.file.size > MAX_FILE_BYTES) throw new SourceError("too-large", entry.path);
    let content = this.text.get(entry.path);
    if (content === undefined) {
      content = snapshot.file.text();
      this.text.set(entry.path, content);
    }
    return content;
  }

  rateLimit(): null {
    return null;
  }
}

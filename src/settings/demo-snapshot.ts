import { SourceError, type DirectoryEntry, type Head, type MessageSource } from "../source/types";

export interface DemoSnapshotFile {
  readonly path: string;
  readonly text: string;
  /**
   * A listing-only entry (a binary or oversized attachment): the file is listed, with its size,
   * so a message's refs resolve, but its content is not in the snapshot and `text` is empty.
   */
  readonly omitted?: true;
  readonly size?: number;
}

export interface DemoSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly revision: string;
  readonly files: readonly DemoSnapshotFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function parseDemoSnapshot(text: string): DemoSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    typeof value.revision !== "string" ||
    value.revision.trim() === "" ||
    !Array.isArray(value.files)
  ) {
    return null;
  }
  const files: DemoSnapshotFile[] = [];
  const seen = new Set<string>();
  for (const entry of value.files) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !safePath(entry.path) ||
      typeof entry.text !== "string" ||
      seen.has(entry.path)
    ) {
      return null;
    }
    seen.add(entry.path);
    if (entry.omitted === undefined) {
      files.push({ path: entry.path, text: entry.text });
    } else if (
      entry.omitted === true &&
      entry.text === "" &&
      typeof entry.size === "number" &&
      Number.isSafeInteger(entry.size) &&
      entry.size >= 0
    ) {
      files.push({ path: entry.path, text: "", omitted: true, size: entry.size });
    } else {
      return null;
    }
  }
  if (!seen.has(".agent-collab")) return null;
  return {
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    revision: value.revision,
    files,
  };
}

async function readSnapshotFile(
  name: string,
  fetcher: typeof fetch,
  documentUrl: string,
): Promise<DemoSnapshot | null> {
  try {
    const url = new URL(name, documentUrl);
    const response = await fetcher(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) return null;
    return parseDemoSnapshot(await response.text());
  } catch {
    return null;
  }
}

export function readDemoSnapshot(
  fetcher: typeof fetch = fetch,
  documentUrl: string = document.baseURI,
): Promise<DemoSnapshot | null> {
  return readSnapshotFile("demo-snapshot.json", fetcher, documentUrl);
}

/** The snapshot a deployment serves next to the app, or null when there is none (or it is invalid). */
export function readHostedSnapshot(
  fetcher: typeof fetch = fetch,
  documentUrl: string = document.baseURI,
): Promise<DemoSnapshot | null> {
  return readSnapshotFile("hosted-snapshot.json", fetcher, documentUrl);
}

function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

export class DemoSnapshotSource implements MessageSource {
  private readonly files = new Map<string, string>();
  /** Sizes of listing-only files, whose content is not in the snapshot. */
  private readonly omitted = new Map<string, number>();
  /** The entries of every directory, listed once per snapshot. */
  private readonly directories = new Map<string, DirectoryEntry[]>();

  constructor(private readonly snapshot: DemoSnapshot) {
    // Every file as (path, content hash, size); a listing-only file hashes its path and size.
    const listed: { path: string; objectId: string; size: number }[] = [];
    const encoder = new TextEncoder();
    for (const file of snapshot.files) {
      if (file.omitted === true) {
        const size = file.size ?? 0;
        this.omitted.set(file.path, size);
        listed.push({
          path: file.path,
          objectId: hash(`omitted:${file.path}:${String(size)}`),
          size,
        });
      } else {
        this.files.set(file.path, file.text);
        listed.push({
          path: file.path,
          objectId: hash(file.text),
          size: encoder.encode(file.text).length,
        });
      }
    }
    const children = new Map<string, Map<string, DirectoryEntry>>();
    const childrenOf = (directory: string) => {
      let entries = children.get(directory);
      if (entries === undefined) {
        entries = new Map();
        children.set(directory, entries);
      }
      return entries;
    };
    for (const { path: filePath, objectId, size } of listed) {
      const parts = filePath.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) {
        const directory = parts.slice(0, depth - 1).join("/");
        const name = parts[depth - 1] as string;
        childrenOf(directory).set(name, {
          name,
          path: directory === "" ? name : `${directory}/${name}`,
          kind: "directory",
          objectId: "",
        });
      }
      const directory = parts.slice(0, -1).join("/");
      const name = parts[parts.length - 1] as string;
      childrenOf(directory).set(name, {
        name,
        path: filePath,
        kind: "file",
        objectId,
        size,
      });
    }
    // Like a tree hash, a directory's id covers everything below it, so a listing cached by id is
    // reused only while nothing under it changed. Deepest directories first.
    const depth = (directory: string) => (directory === "" ? 0 : directory.split("/").length);
    const byDepth = [...children.keys()].sort((left, right) => depth(right) - depth(left));
    const directoryIds = new Map<string, string>();
    for (const directory of byDepth) {
      const entries = [...(children.get(directory) as Map<string, DirectoryEntry>).values()]
        .map((entry) =>
          entry.kind === "directory"
            ? { ...entry, objectId: directoryIds.get(entry.path) ?? "" }
            : entry,
        )
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      directoryIds.set(
        directory,
        hash(entries.map((entry) => `${entry.kind}\0${entry.name}\0${entry.objectId}`).join("\n")),
      );
      this.directories.set(directory, entries);
    }
  }

  head(previous: Head | null): Promise<Head | "not-modified"> {
    if (previous?.validator === this.snapshot.revision) return Promise.resolve("not-modified");
    return Promise.resolve({ revision: this.snapshot.revision, validator: this.snapshot.revision });
  }

  listDirectory(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    if (revision !== this.snapshot.revision) {
      return Promise.reject(
        new SourceError("unexpected", path, null, null, "Snapshot revision mismatch."),
      );
    }
    return Promise.resolve(this.directories.get(path) ?? []);
  }

  readFile(entry: DirectoryEntry): Promise<string> {
    const text = this.files.get(entry.path);
    // A listing-only file is listed so refs resolve, but has no content to read.
    if (text === undefined) return Promise.reject(new SourceError("not-found", entry.path));
    return Promise.resolve(text);
  }

  rateLimit(): null {
    return null;
  }
}

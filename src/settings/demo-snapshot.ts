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

export async function readDemoSnapshot(
  fetcher: typeof fetch = fetch,
  documentUrl: string = document.baseURI,
): Promise<DemoSnapshot | null> {
  try {
    const url = new URL("demo-snapshot.json", documentUrl);
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
  private readonly ids = new Map<string, string>();
  /** Sizes of listing-only files, whose content is not in the snapshot. */
  private readonly omitted = new Map<string, number>();

  constructor(private readonly snapshot: DemoSnapshot) {
    for (const file of snapshot.files) {
      if (file.omitted === true) {
        this.omitted.set(file.path, file.size ?? 0);
        this.ids.set(file.path, hash(`omitted:${file.path}:${String(file.size ?? 0)}`));
      } else {
        this.files.set(file.path, file.text);
        this.ids.set(file.path, hash(file.text));
      }
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
    const prefix = path === "" ? "" : `${path}/`;
    const children = new Map<string, DirectoryEntry>();
    const listed = [
      ...[...this.files].map(([filePath, text]) => [filePath, text] as const),
      ...[...this.omitted.keys()].map((filePath) => [filePath, null] as const),
    ];
    for (const [filePath, text] of listed) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash);
      const childPath = path === "" ? name : `${path}/${name}`;
      if (slash < 0) {
        children.set(name, {
          name,
          path: childPath,
          kind: "file",
          objectId: this.ids.get(filePath) ?? hash(filePath),
          size:
            text === null
              ? (this.omitted.get(filePath) ?? 0)
              : new TextEncoder().encode(text).length,
        });
      } else if (!children.has(name)) {
        children.set(name, { name, path: childPath, kind: "directory", objectId: hash(childPath) });
      }
    }
    return Promise.resolve([...children.values()]);
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

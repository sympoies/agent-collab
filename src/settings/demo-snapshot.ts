import { SourceError, type DirectoryEntry, type Head, type MessageSource } from "../source/types";

export interface DemoSnapshotFile {
  readonly path: string;
  readonly text: string;
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
    files.push({ path: entry.path, text: entry.text });
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

  constructor(private readonly snapshot: DemoSnapshot) {
    for (const file of snapshot.files) {
      this.files.set(file.path, file.text);
      this.ids.set(file.path, hash(file.text));
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
    for (const [filePath, text] of this.files) {
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
          objectId: this.ids.get(filePath) ?? hash(text),
        });
      } else if (!children.has(name)) {
        children.set(name, { name, path: childPath, kind: "directory", objectId: hash(childPath) });
      }
    }
    return Promise.resolve([...children.values()]);
  }

  readFile(entry: DirectoryEntry): Promise<string> {
    const text = this.files.get(entry.path);
    if (text === undefined) return Promise.reject(new SourceError("not-found", entry.path));
    return Promise.resolve(text);
  }

  rateLimit(): null {
    return null;
  }
}

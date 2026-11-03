// In-memory message source over a map of repository files. Used by tests and the demo.

import { SourceError, type DirectoryEntry, type Head, type MessageSource } from "./types";

function hash(text: string): string {
  // FNV-1a, enough to give stable content-addressed ids to fixture objects.
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

export class FixtureSource implements MessageSource {
  /** Paths read through readFile, in order. */
  readonly reads: string[] = [];
  /** Directory paths listed through listDirectory, in order. */
  readonly listings: string[] = [];

  private files = new Map<string, string>();
  private revision = 0;
  private failing = new Set<string>();
  private failingListings = new Set<string>();

  constructor(files: Readonly<Record<string, string>>) {
    this.commit(files);
  }

  /** Replace the repository content with a new revision. */
  commit(files: Readonly<Record<string, string>>): void {
    this.files = new Map(Object.entries(files));
    this.revision += 1;
  }

  /** Make readFile fail with an "unexpected" error for these paths. */
  failReads(paths: readonly string[]): void {
    this.failing = new Set(paths);
  }

  /** Make listDirectory fail with an "unreachable" error for these directory paths. */
  failListings(paths: readonly string[]): void {
    this.failingListings = new Set(paths);
  }

  head(previous: Head | null): Promise<Head | "not-modified"> {
    const revision = `r${this.revision}`;
    if (previous?.validator === revision) return Promise.resolve("not-modified");
    return Promise.resolve({ revision, validator: revision });
  }

  /** Lists the current content; fixtures keep no history, so the revision is not used. */
  listDirectory(_revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    this.listings.push(path);
    if (this.failingListings.has(path)) {
      return Promise.reject(new SourceError("unreachable", path));
    }
    const prefix = path === "" ? "" : `${path}/`;
    const children = new Map<string, DirectoryEntry>();
    for (const [filePath, content] of this.files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      const childPath = `${prefix}${name}`;
      if (slash === -1) {
        children.set(name, {
          name,
          path: childPath,
          kind: "file",
          objectId: hash(content),
          size: new TextEncoder().encode(content).length,
        });
      } else if (!children.has(name)) {
        const tree = [...this.files]
          .filter(([candidate]) => candidate.startsWith(`${childPath}/`))
          .map(([candidate, text]) => `${candidate}\0${hash(text)}`)
          .join("\n");
        children.set(name, { name, path: childPath, kind: "directory", objectId: hash(tree) });
      }
    }
    if (children.size === 0 && path !== "") {
      return Promise.reject(new SourceError("not-found", path, 404));
    }
    return Promise.resolve([...children.values()]);
  }

  readFile(entry: DirectoryEntry): Promise<string> {
    this.reads.push(entry.path);
    const content = this.files.get(entry.path);
    if (this.failing.has(entry.path)) {
      return Promise.reject(new SourceError("unexpected", entry.path, 500));
    }
    if (content === undefined) {
      return Promise.reject(new SourceError("not-found", entry.path, 404));
    }
    return Promise.resolve(content);
  }

  rateLimit(): null {
    return null;
  }
}

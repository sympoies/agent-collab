// A snapshot a deployment serves next to the app, re-read on every poll. Each fetch is the whole
// point-in-time copy; the same revision answers "not modified", so an unchanged copy republishes
// nothing. Reading and listing go through the demo snapshot source of the newest copy.

import {
  DemoSnapshotSource,
  readHostedSnapshot,
  type DemoSnapshot,
} from "../settings/demo-snapshot";
import { SourceError, type DirectoryEntry, type Head, type MessageSource } from "./types";

export class HostedSnapshotSource implements MessageSource {
  private current: { readonly snapshot: DemoSnapshot; readonly source: DemoSnapshotSource } | null =
    null;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly documentUrl: string = document.baseURI,
  ) {}

  async head(previous: Head | null): Promise<Head | "not-modified"> {
    const snapshot = await readHostedSnapshot(this.fetcher, this.documentUrl);
    if (snapshot === null) {
      throw new SourceError("unreachable", "", null, null, "The hosted snapshot is unavailable.");
    }
    if (previous?.validator === snapshot.revision && this.current !== null) return "not-modified";
    this.current = { snapshot, source: new DemoSnapshotSource(snapshot) };
    return this.current.source.head(null);
  }

  /** When the copy on screen was generated. */
  lastChanged(): Date | null {
    return this.current === null ? null : new Date(this.current.snapshot.generatedAt);
  }

  listDirectory(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    return this.opened(path).listDirectory(revision, path);
  }

  readFile(entry: DirectoryEntry): Promise<string> {
    return this.opened(entry.path).readFile(entry);
  }

  rateLimit(): null {
    return null;
  }

  private opened(path: string): DemoSnapshotSource {
    if (this.current === null) throw new SourceError("unexpected", path);
    return this.current.source;
  }
}

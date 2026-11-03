import type { DirectoryEntry, Head, MessageSource, RateLimit } from "./types";

export interface DemoBlobStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CACHE_PREFIX = "agent-collab.public-demo-blob.v1:";

/** Caches immutable public demo blobs only; private repository sources never use this adapter. */
export class CachedDemoSource implements MessageSource {
  constructor(
    private readonly source: MessageSource,
    private readonly storage: DemoBlobStorage | null,
  ) {}

  head(previous: Head | null): Promise<Head | "not-modified"> {
    return this.source.head(previous);
  }

  listDirectory(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    return this.source.listDirectory(revision, path);
  }

  async readFile(entry: DirectoryEntry): Promise<string> {
    const key = `${CACHE_PREFIX}${encodeURIComponent(entry.objectId)}`;
    try {
      const cached = this.storage?.getItem(key);
      if (cached !== null && cached !== undefined) return cached;
    } catch {
      // Browser storage is optional for the public demo.
    }
    const text = await this.source.readFile(entry);
    try {
      this.storage?.setItem(key, text);
    } catch {
      // A quota or privacy setting must not block loading the public demo.
    }
    return text;
  }

  rateLimit(): RateLimit | null {
    return this.source.rateLimit();
  }
}

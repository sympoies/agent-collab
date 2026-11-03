// On-demand access to files that messages reference (topics/ documents): directory listings are
// read only when a card is opened, once per revision and directory.

import { SourceError, type DirectoryEntry, type MessageSource } from "../source/types";

export interface FileInfo {
  readonly path: string;
  readonly name: string;
  /** Size in bytes, or null when the source does not know it. */
  readonly size: number | null;
}

export class AttachmentReader {
  private readonly listings = new Map<string, Promise<readonly DirectoryEntry[] | null>>();

  constructor(
    private readonly source: MessageSource,
    private readonly revision: () => string | null,
  ) {}

  private async entry(path: string): Promise<DirectoryEntry | null> {
    const revision = this.revision();
    if (revision === null) throw new SourceError("unexpected", path);
    const slash = path.lastIndexOf("/");
    const directory = slash === -1 ? "" : path.slice(0, slash);
    const key = `${revision}\0${directory}`;
    let listing = this.listings.get(key);
    if (listing === undefined) {
      listing = this.source.listDirectory(revision, directory).catch((error: unknown) => {
        if (error instanceof SourceError && error.kind === "not-found") return null;
        this.listings.delete(key);
        throw error;
      });
      this.listings.set(key, listing);
    }
    const entries = await listing;
    return entries?.find((entry) => entry.kind === "file" && entry.path === path) ?? null;
  }

  async info(path: string): Promise<FileInfo | null> {
    const entry = await this.entry(path);
    if (entry === null) return null;
    return { path, name: entry.name, size: entry.size ?? null };
  }

  webLink(path: string): { readonly url: string; readonly label: string } | null {
    return this.source.webLink?.(path) ?? null;
  }
}

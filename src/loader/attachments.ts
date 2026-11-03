// On-demand access to files that messages reference (topics/ documents): directory listings are
// read only when a preview or detail is requested, once per revision and directory.

import { SourceError, type DirectoryEntry, type MessageSource } from "../source/types";

export interface FileInfo {
  readonly path: string;
  readonly name: string;
  /** Size in bytes, or null when the source does not know it. */
  readonly size: number | null;
}

export type TextRead =
  | { readonly state: "ready"; readonly text: string }
  | { readonly state: "too-large"; readonly size: number }
  /** The source did not report a size, so the file is not downloaded for a preview. */
  | { readonly state: "unknown-size" };

export type BytesRead =
  | { readonly state: "ready"; readonly bytes: Uint8Array }
  | { readonly state: "too-large"; readonly size: number }
  | { readonly state: "unknown-size" }
  | { readonly state: "unsupported" };

export class AttachmentReader {
  private readonly listings = new Map<string, Promise<readonly DirectoryEntry[] | null>>();
  /** Reads by object id and cap, so opening a card again never downloads the file again. */
  private readonly reads = new Map<string, Promise<TextRead | BytesRead>>();

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

  /** Text of a file within `maxBytes`; a file without a reported size is not downloaded. */
  readText(path: string, maxBytes: number): Promise<TextRead> {
    return this.cachedRead("text", path, maxBytes, async (entry): Promise<TextRead> => {
      if (entry.size === undefined) return { state: "unknown-size" };
      if (entry.size > maxBytes) return { state: "too-large", size: entry.size };
      const text = await this.source.readFile(entry);
      // The listing's size can be wrong; the downloaded text is checked again, in bytes.
      const size = new TextEncoder().encode(text).length;
      return size > maxBytes ? { state: "too-large", size } : { state: "ready", text };
    }) as Promise<TextRead>;
  }

  /** Bytes of a file within `maxBytes`; a file without a reported size is not downloaded. */
  readBytes(path: string, maxBytes: number): Promise<BytesRead> {
    return this.cachedRead("bytes", path, maxBytes, async (entry): Promise<BytesRead> => {
      if (this.source.readBytes === undefined) return { state: "unsupported" };
      if (entry.size === undefined) return { state: "unknown-size" };
      if (entry.size > maxBytes) return { state: "too-large", size: entry.size };
      const bytes = await this.source.readBytes(entry);
      return bytes.length > maxBytes
        ? { state: "too-large", size: bytes.length }
        : { state: "ready", bytes };
    }) as Promise<BytesRead>;
  }

  webLink(path: string): { readonly url: string; readonly label: string } | null {
    return this.source.webLink?.(path, this.revision()) ?? null;
  }

  private async requireEntry(path: string): Promise<DirectoryEntry> {
    const entry = await this.entry(path);
    if (entry === null) throw new SourceError("not-found", path);
    return entry;
  }

  private async cachedRead(
    kind: "text" | "bytes",
    path: string,
    maxBytes: number,
    read: (entry: DirectoryEntry) => Promise<TextRead | BytesRead>,
  ): Promise<TextRead | BytesRead> {
    const entry = await this.requireEntry(path);
    const key = `${kind}\0${entry.objectId}\0${String(maxBytes)}`;
    let result = this.reads.get(key);
    if (result === undefined) {
      result = read(entry);
      this.reads.set(key, result);
      // A failure is not remembered: the next explicit open tries again, never automatically.
      result.catch(() => this.reads.delete(key));
    }
    return result;
  }
}

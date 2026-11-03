// Provider-neutral message-source interface (docs/design.md, section 3).
// UI, loader and parser depend only on this module, never on a concrete provider.

/** Opaque identity of the watched branch at one point in time (a commit id). */
export interface Head {
  readonly revision: string;
  /** Change validator for the next conditional request (an ETag), if supported. */
  readonly validator: string | null;
}

export interface DirectoryEntry {
  /** Last path segment. */
  readonly name: string;
  /** Repository-relative, "/"-separated path. */
  readonly path: string;
  readonly kind: "file" | "directory";
  /** Stable identity for this listed version; content hashes or source metadata may provide it. */
  readonly objectId: string;
  /** Size in bytes when the source knows it without reading the file. */
  readonly size?: number;
}

export interface RateLimit {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
}

export interface MessageSource {
  /** Current head of the watched branch; "not-modified" when `previous` still matches. */
  head(previous: Head | null): Promise<Head | "not-modified">;
  /** Complete listing of one directory at a revision; "" is the repository root. */
  listDirectory(revision: string, path: string): Promise<readonly DirectoryEntry[]>;
  /** UTF-8 text of a file entry obtained from listDirectory. */
  readFile(entry: DirectoryEntry): Promise<string>;
  /** Rate-limit state from the most recent response, or null if unknown. */
  rateLimit(): RateLimit | null;
  /**
   * When the data seen by the latest successful read last changed (for a local folder, the newest
   * file modification time). Sources that cannot tell omit it.
   */
  lastChanged?(): Date | null;
  /** Bytes of a file entry, for image previews. Sources that cannot read bytes omit it. */
  readBytes?(entry: DirectoryEntry): Promise<Uint8Array>;
  /**
   * A link to the file on the provider's web page at `revision` (a branch or default is used when
   * it is null); the label names the provider.
   */
  webLink?(
    path: string,
    revision: string | null,
  ): { readonly url: string; readonly label: string } | null;
}

export type SourceErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "unreachable"
  | "too-large"
  | "unexpected";

/**
 * The only error type a source raises. It never carries credentials, request
 * headers or full URLs; it carries the kind, an optional HTTP status, retry
 * time, safe user-facing message and repository-relative path.
 */
export class SourceError extends Error {
  override readonly name = "SourceError";

  constructor(
    readonly kind: SourceErrorKind,
    readonly path: string,
    readonly status: number | null = null,
    readonly retryAt: Date | null = null,
    message?: string,
  ) {
    super(
      message ??
        `${kind}${status === null ? "" : ` (HTTP ${status})`}: ${path === "" ? "/" : path}`,
    );
  }
}

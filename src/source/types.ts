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
  /** Content-addressed object id (a Git blob or tree id). Immutable. */
  readonly objectId: string;
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
 * headers or full URLs; only the kind, an optional HTTP status and the
 * repository-relative path.
 */
export class SourceError extends Error {
  override readonly name = "SourceError";

  constructor(
    readonly kind: SourceErrorKind,
    readonly path: string,
    readonly status: number | null = null,
    readonly retryAt: Date | null = null,
  ) {
    super(`${kind}${status === null ? "" : ` (HTTP ${status})`}: ${path === "" ? "/" : path}`);
  }
}

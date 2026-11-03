import {
  SourceError,
  type DirectoryEntry,
  type Head,
  type MessageSource,
  type RateLimit,
} from "./types";

/** Public-demo-only source that switches to a known-good static or bundled copy on rate limits. */
export class DemoFallbackSource implements MessageSource {
  private usingFallback = false;

  constructor(
    private readonly live: MessageSource,
    private readonly fallback: MessageSource,
    private readonly onFallback: (error: SourceError) => void,
  ) {}

  head(previous: Head | null): Promise<Head | "not-modified"> {
    return this.run(
      () => this.live.head(previous),
      () => this.fallback.head(previous),
      async () => this.fallback.head(null),
    );
  }

  listDirectory(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    return this.run(
      () => this.live.listDirectory(revision, path),
      () => this.listFallback(path),
      () => this.listFallback(path),
    );
  }

  readFile(entry: DirectoryEntry): Promise<string> {
    return this.run(
      () => this.live.readFile(entry),
      () => this.fallback.readFile(entry),
      () => this.fallback.readFile(entry),
    );
  }

  rateLimit(): RateLimit | null {
    return this.usingFallback ? this.fallback.rateLimit() : this.live.rateLimit();
  }

  private async listFallback(path: string): Promise<readonly DirectoryEntry[]> {
    const head = await this.fallback.head(null);
    if (head === "not-modified") throw new SourceError("unexpected", path);
    return this.fallback.listDirectory(head.revision, path);
  }

  private async run<T>(
    liveCall: () => Promise<T>,
    fallbackCall: () => Promise<T>,
    afterRateLimit: () => Promise<T>,
  ): Promise<T> {
    if (this.usingFallback) return fallbackCall();
    try {
      const value = await liveCall();
      const limit = this.live.rateLimit();
      if (limit !== null && limit.remaining === 0) {
        this.switchToFallback(
          new SourceError(
            "rate-limited",
            "",
            null,
            limit.resetAt,
            "GitHub API rate limit reached.",
          ),
        );
        return await afterRateLimit();
      }
      return value;
    } catch (error) {
      if (error instanceof SourceError && error.kind === "rate-limited") {
        this.switchToFallback(error);
        return fallbackCall();
      }
      throw error;
    }
  }

  private switchToFallback(error: SourceError): void {
    if (this.usingFallback) return;
    this.usingFallback = true;
    this.onFallback(error);
  }
}

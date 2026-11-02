// Loads a collaboration repository through a MessageSource: layout discovery,
// newest-first paging and change detection (docs/design.md, sections 4 and 7).

import { parseMessageFile } from "../message/parse";
import type { ParsedFile } from "../message/types";
import {
  SourceError,
  type DirectoryEntry,
  type Head,
  type MessageSource,
  type RateLimit,
  type SourceErrorKind,
} from "../source/types";

export type TimelineItem =
  | ParsedFile
  | { readonly kind: "unavailable"; readonly path: string; readonly error: SourceErrorKind };

export interface LoaderSnapshot {
  /** Oldest first, ordered by file name (the message id). */
  readonly items: readonly TimelineItem[];
  /** True while older history has not been loaded. */
  readonly hasOlder: boolean;
  /** Paths of items that arrived through refresh after open. */
  readonly fresh: ReadonlySet<string>;
}

export interface LoaderOptions {
  readonly pageSize?: number;
  readonly concurrency?: number;
}

/** The repository is not a readable collaboration repository. */
export class SetupError extends Error {
  override readonly name = "SetupError";
}

const MARKER_FILE = ".agent-collab";
const SUPPORTED_PROTOCOL = "collab-protocol: 1";
const MONTH_RE = /^\d{4}-\d{2}$/;
/** Errors that only affect one file; anything else aborts the operation. */
const PER_FILE_ERRORS: ReadonlySet<SourceErrorKind> = new Set([
  "not-found",
  "too-large",
  "unexpected",
]);

const newestFirst = (a: DirectoryEntry, b: DirectoryEntry): number =>
  a.name === b.name ? (a.path < b.path ? 1 : -1) : a.name < b.name ? 1 : -1;

const isMessageFile = (entry: DirectoryEntry): boolean =>
  entry.kind === "file" && entry.name.endsWith(".md");

const isMonth = (entry: DirectoryEntry): boolean =>
  entry.kind === "directory" && MONTH_RE.test(entry.name);

function itemPath(item: TimelineItem): string {
  return item.kind === "message" ? item.message.path : item.path;
}

function itemName(item: TimelineItem): string {
  const path = itemPath(item);
  return path.slice(path.lastIndexOf("/") + 1);
}

async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await fn(values[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

export class Loader {
  private readonly pageSize: number;
  private readonly concurrency: number;
  private head: Head | null = null;
  /** Loaded items keyed by file name, so a message moved between layouts stays one item. */
  private readonly items = new Map<string, TimelineItem>();
  /** Listed but not yet loaded message files, newest first. */
  private pending: DirectoryEntry[] = [];
  /** Month folders not listed yet, newest first. */
  private unlistedMonths: DirectoryEntry[] = [];
  /** Listed month folders and their object ids. */
  private readonly listedMonths = new Map<string, string>();
  private readonly fresh = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private snapshot: LoaderSnapshot = { items: [], hasOlder: false, fresh: new Set() };
  private queue: Promise<unknown> = Promise.resolve();
  private opening: Promise<void> | null = null;

  constructor(
    private readonly source: MessageSource,
    options: LoaderOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 50;
    this.concurrency = options.concurrency ?? 6;
  }

  getSnapshot = (): LoaderSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Rate-limit state reported by the source. */
  rateLimit(): RateLimit | null {
    return this.source.rateLimit();
  }

  /** Check the marker and load the newest page. Concurrent calls share one attempt. */
  open(): Promise<void> {
    this.opening ??= this.serialize(async () => {
      try {
        const head = await this.source.head(null);
        if (head === "not-modified") throw new SourceError("unexpected", "");
        const root = await this.source.listDirectory(head.revision, "");
        const marker = root.find((entry) => entry.kind === "file" && entry.name === MARKER_FILE);
        if (marker === undefined) {
          throw new SetupError(`not a collaboration repository (no ${MARKER_FILE} marker)`);
        }
        const text = await this.source.readFile(marker);
        const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
        if (firstLine !== SUPPORTED_PROTOCOL) {
          throw new SetupError(`unsupported collaboration protocol: ${firstLine}`);
        }
        const hasInbox = root.some((entry) => entry.kind === "directory" && entry.name === "inbox");
        const inbox = hasInbox ? await this.source.listDirectory(head.revision, "inbox") : [];
        this.head = head;
        this.pending = inbox.filter(isMessageFile).sort(newestFirst);
        this.unlistedMonths = inbox.filter(isMonth).sort(newestFirst);
        await this.loadPage();
      } catch (error) {
        // Start over on the next attempt.
        this.head = null;
        this.pending = [];
        this.unlistedMonths = [];
        this.listedMonths.clear();
        this.opening = null;
        throw error;
      }
    });
    return this.opening;
  }

  /** Load the next older page of history. */
  loadOlder(): Promise<void> {
    return this.serialize(() => this.loadPage());
  }

  /** Poll for changes; resolves to the number of new items. Opens first if open has not succeeded. */
  refresh(): Promise<number> {
    if (this.head === null) return this.open().then(() => 0);
    return this.serialize(async () => {
      const head = await this.source.head(this.head);
      if (head === "not-modified") return 0;
      const inbox = await this.listOrEmpty(head.revision, "inbox");
      const found: DirectoryEntry[] = inbox.filter(
        (entry) => isMessageFile(entry) && !this.isKnown(entry.name),
      );
      const monthUpdates = new Map<string, string>();
      for (const month of inbox.filter(isMonth)) {
        const listedId = this.listedMonths.get(month.name);
        const unlisted = this.unlistedMonths.some((entry) => entry.name === month.name);
        if (unlisted || listedId === month.objectId) continue;
        const entries = await this.source.listDirectory(head.revision, month.path);
        found.push(...entries.filter((e) => isMessageFile(e) && !this.isKnown(e.name)));
        monthUpdates.set(month.name, month.objectId);
      }
      const added = await this.readAll(found);
      for (const [name, objectId] of monthUpdates) this.listedMonths.set(name, objectId);
      for (const item of added) this.fresh.add(itemPath(item));
      this.head = head;
      this.publish(added);
      return added.length;
    });
  }

  private async loadPage(): Promise<void> {
    const batch: DirectoryEntry[] = [];
    try {
      while (batch.length < this.pageSize) {
        const candidate = this.pending[0];
        const nextMonth = this.unlistedMonths[0];
        if (
          candidate !== undefined &&
          (nextMonth === undefined || candidate.name.slice(0, 7) > nextMonth.name)
        ) {
          batch.push(candidate);
          this.pending.shift();
        } else if (nextMonth !== undefined && this.head !== null) {
          const entries = await this.source.listDirectory(this.head.revision, nextMonth.path);
          this.unlistedMonths.shift();
          this.listedMonths.set(nextMonth.name, nextMonth.objectId);
          this.pending = [...this.pending, ...entries.filter(isMessageFile)].sort(newestFirst);
        } else {
          break;
        }
      }
      this.publish(await this.readAll(batch));
    } catch (error) {
      this.pending = [...batch, ...this.pending].sort(newestFirst);
      throw error;
    }
  }

  private async readAll(entries: readonly DirectoryEntry[]): Promise<TimelineItem[]> {
    return mapLimit(entries, this.concurrency, async (entry): Promise<TimelineItem> => {
      try {
        return parseMessageFile(entry.path, await this.source.readFile(entry));
      } catch (error) {
        if (error instanceof SourceError && PER_FILE_ERRORS.has(error.kind)) {
          return { kind: "unavailable", path: entry.path, error: error.kind };
        }
        throw error;
      }
    });
  }

  private async listOrEmpty(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    try {
      return await this.source.listDirectory(revision, path);
    } catch (error) {
      if (error instanceof SourceError && error.kind === "not-found") return [];
      throw error;
    }
  }

  private isKnown(name: string): boolean {
    return this.items.has(name) || this.pending.some((entry) => entry.name === name);
  }

  private publish(added: readonly TimelineItem[]): void {
    for (const item of added) this.items.set(itemName(item), item);
    const items = [...this.items.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, item]) => item);
    this.snapshot = {
      items,
      hasOlder: this.pending.length > 0 || this.unlistedMonths.length > 0,
      fresh: new Set(this.fresh),
    };
    for (const listener of this.listeners) listener();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

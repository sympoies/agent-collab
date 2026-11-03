// Loads a collaboration repository through a MessageSource: layout discovery,
// newest-first paging and change detection (docs/design.md, sections 4 and 7).

import { parseMessageFile } from "../message/parse";
import { AttachmentReader } from "./attachments";
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
  /** Participant roster from the repository marker. */
  readonly participants: readonly string[];
  /** Participants explicitly marked as no longer active. */
  readonly formerParticipants: readonly string[];
  /** True when the marker for the currently published revision was read successfully. */
  readonly rosterKnown: boolean;
  /** Topics with pending/unavailable files, or null when their topics cannot be determined. */
  readonly incompleteTopics: readonly string[] | null;
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
/** Most refreshes between two downloads of a file that keeps failing (about 15 minutes). */
const MAX_RETRY_SPACING = 15;
/** Errors that only affect one file; anything else aborts the operation. */
const PER_FILE_ERRORS: ReadonlySet<SourceErrorKind> = new Set([
  "not-found",
  "too-large",
  "unexpected",
]);

interface MarkerParticipants {
  readonly participants: readonly string[];
  readonly formerParticipants: readonly string[];
}

function markerParticipants(text: string): MarkerParticipants {
  const fields = new Map<string, string>();
  for (const line of text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key === "participants" || key === "former-participants") {
      fields.set(key, line.slice(colon + 1).trim());
    }
  }
  const split = (value: string | undefined): string[] =>
    value === undefined
      ? []
      : value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
  return {
    participants: split(fields.get("participants")),
    formerParticipants: split(fields.get("former-participants")),
  };
}

function topicsForMessagePath(path: string, senders: readonly string[]): readonly string[] | null {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{4})-(.+)-(\d{2})\.md$/.exec(fileName);
  if (match === null) return null;
  const senderAndTopic = match[2] as string;
  const topics = new Set<string>();
  for (const sender of senders) {
    const prefix = `${sender}-`;
    if (!senderAndTopic.startsWith(prefix)) continue;
    const topic = senderAndTopic.slice(prefix.length);
    if (/^[a-z0-9-]+$/.test(topic)) topics.add(topic);
  }
  return topics.size === 0 ? null : [...topics];
}

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

interface RetryState {
  entry: DirectoryEntry;
  attempts: number;
  /** Refreshes left until the next download attempt. */
  wait: number;
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
  /**
   * Files shown as unavailable, keyed by file name. Refresh downloads them
   * again with growing spacing: after 1, 2, 4, ... refreshes, at most 15.
   */
  private readonly unavailable = new Map<string, RetryState>();
  private readonly fresh = new Set<string>();
  private participants: readonly string[] = [];
  private formerParticipants: readonly string[] = [];
  private rosterKnown = false;
  private markerCache: {
    readonly objectId: string;
    readonly participants: MarkerParticipants;
  } | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: LoaderSnapshot = {
    items: [],
    hasOlder: false,
    fresh: new Set(),
    participants: [],
    formerParticipants: [],
    rosterKnown: false,
    incompleteTopics: null,
  };
  private queue: Promise<unknown> = Promise.resolve();
  private opening: Promise<void> | null = null;
  /** Files that messages reference, read on demand at the current revision. */
  readonly attachments: AttachmentReader;

  constructor(
    private readonly source: MessageSource,
    options: LoaderOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 50;
    this.concurrency = options.concurrency ?? 6;
    this.attachments = new AttachmentReader(source, () => this.head?.revision ?? null);
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

  private async readMarker(root: readonly DirectoryEntry[]): Promise<MarkerParticipants> {
    const entry = root.find(
      (candidate) => candidate.kind === "file" && candidate.name === MARKER_FILE,
    );
    if (entry === undefined) {
      throw new SetupError(`not a collaboration repository (no ${MARKER_FILE} marker)`);
    }
    if (this.markerCache?.objectId === entry.objectId) return this.markerCache.participants;
    const text = await this.source.readFile(entry);
    const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (firstLine !== SUPPORTED_PROTOCOL) {
      throw new SetupError(`unsupported collaboration protocol: ${firstLine}`);
    }
    const participants = markerParticipants(text);
    this.markerCache = { objectId: entry.objectId, participants };
    return participants;
  }

  /** Check the marker and load the newest page. Concurrent calls share one attempt. */
  open(): Promise<void> {
    this.opening ??= this.serialize(async () => {
      try {
        const head = await this.source.head(null);
        if (head === "not-modified") throw new SourceError("unexpected", "");
        const root = await this.source.listDirectory(head.revision, "");
        const participantData = await this.readMarker(root);
        this.participants = participantData.participants;
        this.formerParticipants = participantData.formerParticipants;
        this.rosterKnown = true;
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
        this.unavailable.clear();
        this.participants = [];
        this.formerParticipants = [];
        this.rosterKnown = false;
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

  /**
   * Poll for changes and download unavailable files again; resolves to the
   * number of new items. Opens first if open has not succeeded.
   */
  refresh(): Promise<number> {
    if (this.head === null) return this.open().then(() => 0);
    return this.serialize(async () => {
      const head = await this.source.head(this.head);
      if (head === "not-modified") {
        const retries = this.dueRetries();
        if (retries.length > 0) this.publish(await this.readAll(retries));
        return 0;
      }
      this.rosterKnown = false;
      try {
        const root = await this.source.listDirectory(head.revision, "");
        const participantData = await this.readMarker(root);
        const inbox = await this.listOrEmpty(head.revision, "inbox");
        this.updateRetries(inbox);
        const found: DirectoryEntry[] = inbox.filter(
          (entry) => isMessageFile(entry) && !this.isKnown(entry.name),
        );
        const monthUpdates = new Map<string, string>();
        for (const month of inbox.filter(isMonth)) {
          const listedId = this.listedMonths.get(month.name);
          const unlisted = this.unlistedMonths.some((entry) => entry.name === month.name);
          if (unlisted || listedId === month.objectId) continue;
          const entries = await this.source.listDirectory(head.revision, month.path);
          this.updateRetries(entries);
          found.push(...entries.filter((e) => isMessageFile(e) && !this.isKnown(e.name)));
          monthUpdates.set(month.name, month.objectId);
        }
        const retries = this.dueRetries();
        const added = await this.readAll(found);
        const recovered = await this.readAll(retries);
        const arrived = added.filter((item) => item.kind !== "unavailable");
        for (const [name, objectId] of monthUpdates) this.listedMonths.set(name, objectId);
        for (const item of arrived) this.fresh.add(itemPath(item));
        this.head = head;
        this.participants = participantData.participants;
        this.formerParticipants = participantData.formerParticipants;
        this.rosterKnown = true;
        this.publish([...added, ...recovered]);
        return arrived.length;
      } catch (error) {
        this.participants = [];
        this.formerParticipants = [];
        this.publish([]);
        throw error;
      }
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
        const item = parseMessageFile(entry.path, await this.source.readFile(entry));
        this.unavailable.delete(entry.name);
        return item;
      } catch (error) {
        if (error instanceof SourceError && PER_FILE_ERRORS.has(error.kind)) {
          const attempts = (this.unavailable.get(entry.name)?.attempts ?? 0) + 1;
          const wait = Math.min(2 ** (attempts - 1), MAX_RETRY_SPACING);
          this.unavailable.set(entry.name, { entry, attempts, wait });
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

  /** Counts one refresh down for every unavailable file; returns the files due again. */
  private dueRetries(): DirectoryEntry[] {
    const due: DirectoryEntry[] = [];
    for (const state of this.unavailable.values()) {
      state.wait -= 1;
      if (state.wait <= 0) due.push(state.entry);
    }
    return due;
  }

  /** Keeps the newest listed entry of an unavailable file for its next attempt. */
  private updateRetries(entries: readonly DirectoryEntry[]): void {
    for (const entry of entries) {
      const state = this.unavailable.get(entry.name);
      if (state !== undefined) state.entry = entry;
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
      participants: this.participants,
      formerParticipants: this.formerParticipants,
      rosterKnown: this.rosterKnown,
      incompleteTopics: this.incompleteTopics(),
    };
    for (const listener of this.listeners) listener();
  }

  private incompleteTopics(): readonly string[] | null {
    if (!this.rosterKnown || this.unlistedMonths.length > 0) return null;
    const senders = [...this.participants, ...this.formerParticipants];
    const incompletePaths = [
      ...this.pending.map((entry) => entry.path),
      ...[...this.unavailable.values()].map((retry) => retry.entry.path),
    ];
    const topics = new Set<string>();
    for (const path of incompletePaths) {
      const possibleTopics = topicsForMessagePath(path, senders);
      if (possibleTopics === null) return null;
      for (const topic of possibleTopics) topics.add(topic);
    }
    return [...topics].sort();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

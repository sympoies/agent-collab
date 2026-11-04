// Loads a collaboration repository through a MessageSource: layout discovery,
// newest-first paging and change detection (docs/design.md, sections 4 and 7).

import { parseMessageFile } from "../message/parse";
import { isKnownLayout, markerLayout } from "../message/topic-layout";
import { mapLimit } from "../source/map-limit";
import { TopicLayoutSource } from "../source/topic-layout";
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
  /** After a jump, the last day of the loaded range: newer messages may exist and are not loaded. */
  readonly jumpedTo: string | null;
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
  /** When the source's data last changed, as of the latest successful read, or null. */
  readonly lastChanged: Date | null;
}

export interface LoaderOptions {
  readonly pageSize?: number;
  readonly concurrency?: number;
  /**
   * Drops a loaded item that does not belong in this view (a topic view of the legacy inbox, whose
   * file names cannot say exactly which topic a message has). A dropped file is not read again.
   */
  readonly keep?: (item: TimelineItem) => boolean;
}

/** The repository is not a readable collaboration repository. */
export class SetupError extends Error {
  override readonly name = "SetupError";

  /** `code` and `detail` let the UI word the problem in the user's language. */
  constructor(
    message: string,
    readonly code: "no-marker" | "protocol" | "layout",
    readonly detail = "",
  ) {
    super(message);
  }
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

interface RetryState {
  entry: DirectoryEntry;
  attempts: number;
  /** Refreshes left until the next download attempt. */
  wait: number;
}

export class Loader {
  private readonly pageSize: number;
  private readonly concurrency: number;
  private readonly keep: (item: TimelineItem) => boolean;
  /** Files read and dropped by `keep`, so a refresh does not treat them as new. */
  private readonly ignored = new Set<string>();
  private head: Head | null = null;
  /** Loaded items keyed by file name, so a message moved between layouts stays one item. */
  private readonly items = new Map<string, TimelineItem>();
  /** Listed but not yet loaded message files, newest first. */
  private pending: DirectoryEntry[] = [];
  /** The latest listing of `inbox`, kept so a jump needs no request of its own. */
  private inbox: readonly DirectoryEntry[] = [];
  /** After a jump, the last day (YYYY-MM-DD) of the loaded range; null while the newest page leads. */
  private cutoff: string | null = null;
  /** Month folders not listed yet, newest first. */
  private unlistedMonths: DirectoryEntry[] = [];
  /** Listed month folders and their object ids. */
  private readonly listedMonths = new Map<string, string>();
  /**
   * Files shown as unavailable, keyed by file name. Refresh downloads them
   * again with growing spacing: after 1, 2, 4, ... refreshes, at most 15.
   */
  private readonly unavailable = new Map<string, RetryState>();
  /** Object id each loaded file was read at, to notice a file edited in place. */
  private readonly loadedIds = new Map<string, string>();
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
    jumpedTo: null,
    fresh: new Set(),
    participants: [],
    formerParticipants: [],
    rosterKnown: false,
    incompleteTopics: null,
    lastChanged: null,
  };
  private queue: Promise<unknown> = Promise.resolve();
  private opening: Promise<void> | null = null;
  /** Files that messages reference, read on demand at the current revision. */
  readonly attachments: AttachmentReader;

  private readonly source: MessageSource;

  constructor(source: MessageSource, options: LoaderOptions = {}) {
    // A repository in the topic layout is read through one merged inbox; others pass through.
    this.source = source instanceof TopicLayoutSource ? source : new TopicLayoutSource(source);
    this.pageSize = options.pageSize ?? 50;
    this.concurrency = options.concurrency ?? 6;
    this.keep = options.keep ?? (() => true);
    this.attachments = new AttachmentReader(this.source, () => this.head?.revision ?? null);
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
      throw new SetupError(
        `not a collaboration repository (no ${MARKER_FILE} marker)`,
        "no-marker",
      );
    }
    if (this.markerCache?.objectId === entry.objectId) return this.markerCache.participants;
    const text = await this.source.readFile(entry);
    const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (firstLine !== SUPPORTED_PROTOCOL) {
      throw new SetupError(
        `unsupported collaboration protocol: ${firstLine}`,
        "protocol",
        firstLine,
      );
    }
    const layout = markerLayout(text);
    if (!isKnownLayout(layout)) {
      throw new SetupError(`unsupported inbox layout: ${layout}`, "layout", layout);
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
        // The topic layout has no root inbox of its own; a missing one is an empty listing.
        const inbox = await this.listOrEmpty(head.revision, "inbox");
        this.head = head;
        this.inbox = inbox;
        this.cutoff = null;
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
   * Show the page of messages that ends on `date` (YYYY-MM-DD) instead of the newest page, or the
   * newest page again for null. The month folders and files listed at open give the position, so
   * this lists the one month folder the page starts in and reads one page: the messages between
   * the chosen day and the newest page are never loaded. Older pages continue with loadOlder.
   */
  jumpTo(date: string | null): Promise<void> {
    return this.serialize(async () => {
      if (this.head === null) return;
      const month = date?.slice(0, 7) ?? "";
      // Files and later month folders in the listing already tell whether newer messages exist.
      let newer =
        date !== null &&
        this.inbox.some((entry) =>
          isMessageFile(entry)
            ? entry.name.slice(0, 10) > date
            : isMonth(entry) && entry.name > month,
        );
      // Otherwise only the chosen day's own month folder can hold later days; it is the one
      // listing the page needs anyway, so its names decide.
      const own = this.inbox.find((entry) => isMonth(entry) && entry.name === month);
      let ownFiles: readonly DirectoryEntry[] = [];
      if (date !== null && own !== undefined) {
        ownFiles = (await this.source.listDirectory(this.head.revision, own.path)).filter(
          isMessageFile,
        );
        newer ||= ownFiles.some((entry) => entry.name.slice(0, 10) > date);
      }
      this.cutoff = newer ? date : null;
      this.items.clear();
      this.loadedIds.clear();
      this.fresh.clear();
      this.unavailable.clear();
      this.listedMonths.clear();
      if (own !== undefined && date !== null) this.listedMonths.set(own.name, own.objectId);
      this.pending = [...this.inbox.filter(isMessageFile), ...ownFiles]
        .filter((entry) => this.inRange(entry.name))
        .sort(newestFirst);
      this.unlistedMonths = this.inbox
        .filter(
          (entry) =>
            isMonth(entry) && entry !== own && (this.cutoff === null || entry.name <= month),
        )
        .sort(newestFirst);
      await this.loadPage();
    });
  }

  /** Whether a message file name lies in the loaded range (not after the jump's last day). */
  private inRange(name: string): boolean {
    return this.cutoff === null || name.slice(0, 10) <= this.cutoff;
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
        this.updatePending(inbox);
        const found: DirectoryEntry[] = inbox.filter(
          (entry) =>
            isMessageFile(entry) &&
            this.inRange(entry.name) &&
            (!this.isKnown(entry.name) || this.isEdited(entry)),
        );
        const monthUpdates = new Map<string, string>();
        for (const month of inbox.filter(isMonth)) {
          const listedId = this.listedMonths.get(month.name);
          const unlisted = this.unlistedMonths.some((entry) => entry.name === month.name);
          const afterRange = this.cutoff !== null && month.name > this.cutoff.slice(0, 7);
          if (unlisted || afterRange || listedId === month.objectId) continue;
          const entries = await this.source.listDirectory(head.revision, month.path);
          this.updateRetries(entries);
          this.updatePending(entries);
          found.push(
            ...entries.filter(
              (e) =>
                isMessageFile(e) &&
                this.inRange(e.name) &&
                (!this.isKnown(e.name) || this.isEdited(e)),
            ),
          );
          monthUpdates.set(month.name, month.objectId);
        }
        const retries = this.dueRetries();
        // A file edited in place replaces its item; it is not a new arrival.
        const edited = new Set(
          found.filter((entry) => this.items.has(entry.name)).map((e) => e.name),
        );
        const added = await this.readAll(found);
        const recovered = await this.readAll(retries);
        const arrived = added.filter(
          (item) => item.kind !== "unavailable" && !edited.has(itemName(item)),
        );
        for (const [name, objectId] of monthUpdates) this.listedMonths.set(name, objectId);
        for (const item of arrived) this.fresh.add(itemPath(item));
        this.head = head;
        this.inbox = inbox;
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
          const inRange = entries.filter(
            (entry) => isMessageFile(entry) && this.inRange(entry.name),
          );
          this.pending = [...this.pending, ...inRange].sort(newestFirst);
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
    const all = await this.readEntries(entries);
    return all.filter((item) => {
      if (this.keep(item)) return true;
      this.ignored.add(itemName(item));
      return false;
    });
  }

  private async readEntries(entries: readonly DirectoryEntry[]): Promise<TimelineItem[]> {
    return mapLimit(entries, this.concurrency, async (entry): Promise<TimelineItem> => {
      try {
        const item = parseMessageFile(entry.path, await this.source.readFile(entry));
        this.unavailable.delete(entry.name);
        this.loadedIds.set(entry.name, entry.objectId);
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

  /** A loaded file whose object id differs from the one it was read at was edited in place. */
  private isEdited(entry: DirectoryEntry): boolean {
    const loaded = this.loadedIds.get(entry.name);
    return loaded !== undefined && loaded !== entry.objectId;
  }

  /** Keeps the newest listed entry of a file that is listed but not loaded yet. */
  private updatePending(entries: readonly DirectoryEntry[]): void {
    for (const entry of entries) {
      const index = this.pending.findIndex((candidate) => candidate.name === entry.name);
      if (index !== -1) this.pending[index] = entry;
    }
  }

  private isKnown(name: string): boolean {
    return (
      this.items.has(name) ||
      this.ignored.has(name) ||
      this.pending.some((entry) => entry.name === name)
    );
  }

  private publish(added: readonly TimelineItem[]): void {
    for (const item of added) this.items.set(itemName(item), item);
    const items = [...this.items.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, item]) => item);
    this.snapshot = {
      items,
      hasOlder: this.pending.length > 0 || this.unlistedMonths.length > 0,
      jumpedTo: this.cutoff,
      fresh: new Set(this.fresh),
      participants: this.participants,
      formerParticipants: this.formerParticipants,
      rosterKnown: this.rosterKnown,
      incompleteTopics: this.incompleteTopics(),
      lastChanged: this.source.lastChanged?.() ?? null,
    };
    for (const listener of this.listeners) listener();
  }

  private incompleteTopics(): readonly string[] | null {
    if (!this.rosterKnown || this.unlistedMonths.length > 0 || this.cutoff !== null) return null;
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

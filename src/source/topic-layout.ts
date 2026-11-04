// Presents a repository in the topic layout as the one tree the loader already reads: a virtual
// `inbox/` whose month folders merge `topics/<topic>/inbox/YYYY-MM` of every topic with the legacy
// `inbox/` (docs/design/topics-and-scale.md, sections 4.6 and 6.1). Messages keep their real
// paths, so nothing downstream guesses where a message lives. Every other path, and every
// repository that is not in the topic layout, passes through untouched.

import { isTopicFolderName, markerLayout } from "../message/topic-layout";
import { mapLimit } from "./map-limit";
import {
  SourceError,
  type DirectoryEntry,
  type Head,
  type MessageSource,
  type RateLimit,
} from "./types";

const MARKER = ".agent-collab";
const MONTH_RE = /^\d{4}-\d{2}$/;
/**
 * Most topic folders the merged view reads. Each one costs a listing of its own, so a repository
 * with more is refused with the usual "too large" error rather than flooding the provider; a
 * topic is then opened on its own (`topicLoader`).
 */
export const MAX_MERGED_TOPICS = 200;
/** Topic listings in flight at once, like the loader's reads. */
const LISTING_CONCURRENCY = 6;

function hash(text: string): string {
  // FNV-1a: a stable identity for a listing assembled from several real directories.
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

export interface TopicLayoutOptions {
  /**
   * Show only this topic: its folder, plus the legacy messages whose file name ends in that topic
   * (a hint; the parsed topic of each message is what the UI trusts).
   */
  readonly topic?: string;
}

export class TopicLayoutSource implements MessageSource {
  /** The marker entry of the latest root listing, and its text once read. */
  private marker: DirectoryEntry | null = null;
  private readonly markerTexts = new Map<string, string>();
  /** The topic inbox listings of the latest revision asked about, shared by the inbox and months. */
  private cached: { readonly revision: string; readonly listings: Promise<TopicInboxes> } | null =
    null;
  /**
   * Listings kept across revisions, keyed by the object id of the directory they list: a topic
   * folder or a month folder whose id did not change is not listed again (the ids come from the
   * parent listing, so reusing a listing costs no request and no directory read).
   */
  private inboxMemo = new Map<string, readonly DirectoryEntry[]>();
  private monthMemo = new Map<string, readonly DirectoryEntry[]>();

  constructor(
    private readonly inner: MessageSource,
    private readonly options: TopicLayoutOptions = {},
  ) {}

  get participantsKnown(): boolean {
    return this.inner.participantsKnown !== false;
  }

  head(previous: Head | null): Promise<Head | "not-modified"> {
    return this.inner.head(previous);
  }

  async listDirectory(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    if (path === "") {
      const entries = await this.inner.listDirectory(revision, "");
      this.marker = entries.find((e) => e.kind === "file" && e.name === MARKER) ?? null;
      return entries;
    }
    if (path !== "inbox" && !path.startsWith("inbox/")) {
      return this.inner.listDirectory(revision, path);
    }
    if (!(await this.isTopicLayout())) return this.inner.listDirectory(revision, path);
    return path === "inbox"
      ? this.listInbox(revision)
      : this.listMonth(revision, path.slice("inbox/".length));
  }

  async readFile(entry: DirectoryEntry): Promise<string> {
    const text = await this.inner.readFile(entry);
    if (entry.path === MARKER) this.markerTexts.set(entry.objectId, text);
    return text;
  }

  rateLimit(): RateLimit | null {
    return this.inner.rateLimit();
  }

  lastChanged(): Date | null {
    return this.inner.lastChanged?.() ?? null;
  }

  lastChangedPath(): string | null {
    return this.inner.lastChangedPath?.() ?? null;
  }

  readBytes(entry: DirectoryEntry): Promise<Uint8Array> {
    if (this.inner.readBytes === undefined) {
      return Promise.reject(new SourceError("unexpected", entry.path));
    }
    return this.inner.readBytes(entry);
  }

  webLink(
    path: string,
    revision: string | null,
  ): { readonly url: string; readonly label: string } | null {
    return this.inner.webLink?.(path, revision) ?? null;
  }

  /** Whether the marker of the listed root says `inbox-layout: topic`. */
  private async isTopicLayout(): Promise<boolean> {
    const entry = this.marker;
    if (entry === null) return false;
    let text = this.markerTexts.get(entry.objectId);
    if (text === undefined) {
      text = await this.readFile(entry);
    }
    return markerLayout(text) === "topic";
  }

  private async optional(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    try {
      return await this.inner.listDirectory(revision, path);
    } catch (error) {
      if (error instanceof SourceError && error.kind === "not-found") return [];
      throw error;
    }
  }

  /** The topic folders to read, with their object ids: every valid folder, or just the scoped one. */
  private async topicFolders(
    revision: string,
  ): Promise<readonly { readonly name: string; readonly objectId: string | null }[]> {
    const wanted = this.options.topic;
    if (wanted !== undefined) {
      return isTopicFolderName(wanted) ? [{ name: wanted, objectId: null }] : [];
    }
    const entries = await this.optional(revision, "topics");
    const folders = entries
      .filter((entry) => entry.kind === "directory" && isTopicFolderName(entry.name))
      .map((entry) => ({ name: entry.name, objectId: entry.objectId }));
    if (folders.length > MAX_MERGED_TOPICS) {
      throw new SourceError(
        "too-large",
        "topics",
        null,
        null,
        `more than ${String(MAX_MERGED_TOPICS)} topic folders; open one topic at a time`,
      );
    }
    return folders;
  }

  /**
   * `topics/<topic>/inbox` of every topic, listed at most a few at a time and once per revision.
   * A topic whose folder id did not change since an earlier revision is not listed again.
   */
  private inboxes(revision: string): Promise<TopicInboxes> {
    if (this.cached?.revision !== revision) {
      const listings = (async (): Promise<TopicInboxes> => {
        const folders = await this.topicFolders(revision);
        const next = new Map<string, readonly DirectoryEntry[]>();
        const lists = await mapLimit(folders, LISTING_CONCURRENCY, async (folder) => {
          const key = folder.objectId === null ? null : `${folder.name}:${folder.objectId}`;
          const known = key === null ? undefined : this.inboxMemo.get(key);
          const list = known ?? (await this.optional(revision, `topics/${folder.name}/inbox`));
          if (key !== null) next.set(key, list);
          return list;
        });
        const result: TopicInboxes = new Map(
          folders.map((folder, index) => [folder.name, lists[index] ?? []]),
        );
        // Only what this revision uses is kept, so the memory follows the repository.
        this.inboxMemo = next;
        const liveMonths = new Set<string>();
        for (const [topic, entries] of result) {
          for (const entry of entries) {
            if (entry.kind === "directory")
              liveMonths.add(`${topic}/${entry.name}:${entry.objectId}`);
          }
        }
        this.monthMemo = new Map([...this.monthMemo].filter(([key]) => liveMonths.has(key)));
        return result;
      })();
      this.cached = { revision, listings };
      listings.catch(() => {
        if (this.cached?.listings === listings) this.cached = null;
      });
    }
    return this.cached.listings;
  }

  private keepLegacy(entry: DirectoryEntry): boolean {
    const topic = this.options.topic;
    return topic === undefined || new RegExp(`-${topic}-\\d{2}\\.md$`).test(entry.name);
  }

  private async listInbox(revision: string): Promise<readonly DirectoryEntry[]> {
    const [legacy, inboxes] = await Promise.all([
      this.optional(revision, "inbox"),
      this.inboxes(revision),
    ]);
    const files = legacy.filter(
      (entry) => entry.kind === "file" && entry.name.endsWith(".md") && this.keepLegacy(entry),
    );
    const months = new Map<string, string[]>();
    const add = (entry: DirectoryEntry) => {
      if (entry.kind !== "directory" || !MONTH_RE.test(entry.name)) return;
      months.set(entry.name, [
        ...(months.get(entry.name) ?? []),
        `${entry.path}:${entry.objectId}`,
      ]);
    };
    for (const entry of legacy) add(entry);
    for (const entries of inboxes.values()) for (const entry of entries) add(entry);
    const directories: DirectoryEntry[] = [...months].map(([name, parts]) => ({
      name,
      path: `inbox/${name}`,
      kind: "directory",
      objectId: hash(parts.sort().join("\n")),
    }));
    return [...files, ...directories];
  }

  private async listMonth(revision: string, month: string): Promise<readonly DirectoryEntry[]> {
    if (!MONTH_RE.test(month)) throw new SourceError("not-found", `inbox/${month}`, 404);
    const [legacy, inboxes] = await Promise.all([
      this.optional(revision, `inbox/${month}`),
      this.inboxes(revision),
    ]);
    // Only the topics that have this month are listed, and a month folder whose id did not change
    // since an earlier revision is not listed again.
    const withMonth = [...inboxes].flatMap(([topic, entries]) => {
      const folder = entries.find((entry) => entry.kind === "directory" && entry.name === month);
      return folder === undefined ? [] : [{ topic, key: `${topic}/${month}:${folder.objectId}` }];
    });
    const lists = await mapLimit(withMonth, LISTING_CONCURRENCY, async ({ topic, key }) => {
      const known = this.monthMemo.get(key);
      if (known !== undefined) return known;
      const list = await this.optional(revision, `topics/${topic}/inbox/${month}`);
      this.monthMemo.set(key, list);
      return list;
    });
    const entries = [...legacy.filter((entry) => this.keepLegacy(entry)), ...lists.flat()].filter(
      (entry) => entry.kind === "file",
    );
    if (entries.length === 0) throw new SourceError("not-found", `inbox/${month}`, 404);
    return entries;
  }
}

type TopicInboxes = ReadonlyMap<string, readonly DirectoryEntry[]>;

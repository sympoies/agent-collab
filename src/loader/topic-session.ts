// A viewing session of a topic-layout repository (docs/design/topics-and-scale.md, sections 6.2
// and 6.5): the topic list, a loader per opened topic and the generated-file digests, all kept in
// memory for the session and keyed by object id. A refresh looks at the `topics/` listing, and only
// a topic whose tree id changed is read again; an unchanged topic, closed or idle, costs nothing.
// Nothing here touches browser storage: a private repository stays in memory.

import {
  MAX_GENERATED_BYTES,
  parseTopicIndex,
  parseTopicOpen,
  type OpenItem,
  type TopicIndex,
} from "../message/generated-index";
import { isTopicFolderName, parseRootIndex, type TopicSummary } from "../message/topic-layout";
import { SourceError, type DirectoryEntry, type Head, type MessageSource } from "../source/types";
import type { Loader, LoaderOptions, LoaderSnapshot } from "./loader";
import { readRepositoryMetadata, topicLoader } from "./topic-reader";

/** What the viewer knows of a topic's size and recency without loading its messages. */
export interface TopicDigest {
  /** Messages, from the topic's `index.md`; null when the index could not be trusted. */
  readonly count: number | null;
  /** The newest message id, from the index or, failing that, the newest listed file name. */
  readonly newestId: string | null;
  readonly fromIndex: boolean;
  /** Every message id of the topic, sorted, when the index could be trusted (for unread counts). */
  readonly ids?: readonly string[] | null;
}

interface TopicState {
  readonly summary: TopicSummary;
  /** Object id of `topics/<name>`; null for a legacy-only topic, which has no folder. */
  readonly treeId: string | null;
}

export class TopicSession {
  private head: Head | null = null;
  private states = new Map<string, TopicState>();
  private roster: Pick<LoaderSnapshot, "participants" | "formerParticipants" | "rosterKnown"> = {
    participants: [],
    formerParticipants: [],
    rosterKnown: false,
  };
  private readonly loaders = new Map<string, { loader: Loader; treeId: string | null }>();
  private readonly digests = new Map<string, { treeId: string | null; digest: TopicDigest }>();
  /** Digest reads in progress, so a caller that asks again joins the read instead of repeating it. */
  private readonly digestReads = new Map<
    string,
    { treeId: string; promise: Promise<TopicDigest> }
  >();
  private readonly openCache = new Map<
    string,
    { treeId: string | null; items: readonly OpenItem[] | null }
  >();
  private indexCache: { objectId: string; rows: ReturnType<typeof parseRootIndex> } | null = null;
  private layout = "";

  constructor(
    private readonly source: MessageSource,
    private readonly options: LoaderOptions = {},
  ) {}

  /** The topics as of the latest open or refresh: folders first, then legacy-only topics. */
  topics(): readonly TopicSummary[] {
    return [...this.states.values()].map((state) => state.summary);
  }

  /** The head used by the most recent successful open or refresh. */
  get currentHead(): Head | null {
    return this.head;
  }

  /** Root participant metadata, available from the topic list before a message loader opens. */
  get rosterSnapshot(): Pick<
    LoaderSnapshot,
    "participants" | "formerParticipants" | "rosterKnown"
  > {
    return this.roster;
  }

  /** Reads the marker, `topics/` and the root index (the handful of requests of section 6.1). */
  async open(): Promise<void> {
    const head = await this.source.head(null);
    if (head === "not-modified") throw new SourceError("unexpected", "");
    await this.read(head);
  }

  /**
   * A loader for one topic, kept for the session so coming back to a topic shows what is loaded.
   * It is not opened here; the caller opens it when the topic is chosen.
   */
  loader(topic: string): Loader {
    const known = this.loaders.get(topic);
    if (known !== undefined) return known.loader;
    const loader = topicLoader(this.source, topic, this.options);
    this.loaders.set(topic, { loader, treeId: this.states.get(topic)?.treeId ?? null });
    return loader;
  }

  /**
   * Checks the repository for changes with one conditional request. When the head moved, the
   * `topics/` listing is read again. Every opened topic whose tree id differs from the one its
   * loader last caught up with refreshes its loader, each on its own: one that fails does not stop
   * the others, stays marked as behind, and is tried again by the next `refresh()` even when the
   * repository has not moved since. Resolves to the names of the topics that changed (new ones
   * included); if any loader failed, it throws after the others finished.
   */
  async refresh(): Promise<readonly string[]> {
    if (this.head === null) {
      await this.open();
      return this.topics().map((topic) => topic.name);
    }
    const before = this.states;
    const head = await this.source.head(this.head);
    if (head !== "not-modified") await this.read(head);
    const changed = new Set<string>();
    for (const [name, state] of this.states) {
      if (before.get(name)?.treeId !== state.treeId || before.get(name) === undefined) {
        changed.add(name);
      }
    }
    for (const name of before.keys()) if (!this.states.has(name)) changed.add(name);

    const behind: string[] = [];
    for (const [name, opened] of [...this.loaders]) {
      const state = this.states.get(name);
      if (state === undefined) {
        this.loaders.delete(name);
      } else if (state.treeId !== opened.treeId) {
        behind.push(name);
      }
    }
    const results = await Promise.allSettled(
      behind.map(async (name) => {
        const opened = this.loaders.get(name);
        await opened?.loader.refresh();
        // Only now is this topic current; a failure leaves it behind for the next refresh.
        if (opened !== undefined) opened.treeId = this.states.get(name)?.treeId ?? null;
        return name;
      }),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    for (const name of behind) changed.add(name);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures);
    return [...changed].sort();
  }

  /**
   * The count and newest id of a topic from its `index.md` (a fast path, untrusted: 6.5), or, when
   * that file is missing, oversized or unreadable, the newest listed file name. Kept while the
   * topic's tree id is unchanged.
   */
  async digest(topic: string): Promise<TopicDigest> {
    const state = this.states.get(topic);
    const head = this.head;
    if (state?.treeId == null || head === null || !isTopicFolderName(topic)) {
      return { count: null, newestId: null, fromIndex: false };
    }
    const known = this.digests.get(topic);
    if (known?.treeId === state.treeId) return known.digest;
    const reading = this.digestReads.get(topic);
    if (reading?.treeId === state.treeId) return reading.promise;
    const treeId = state.treeId;
    const promise: Promise<TopicDigest> = this.readDigest(head.revision, topic)
      .then((digest) => {
        this.digests.set(topic, { treeId, digest });
        return digest;
      })
      .finally(() => {
        if (this.digestReads.get(topic)?.promise === promise) this.digestReads.delete(topic);
      });
    this.digestReads.set(topic, { treeId, promise });
    return promise;
  }

  /**
   * The rows of the topic's `open.md` (untrusted, 6.5), or null when the topic has none, it is too
   * large or unreadable. Kept while the topic's tree id is unchanged.
   */
  async openItems(topic: string): Promise<readonly OpenItem[] | null> {
    const state = this.states.get(topic);
    const head = this.head;
    if (state?.treeId == null || head === null || !isTopicFolderName(topic)) return null;
    const known = this.openCache.get(topic);
    if (known?.treeId === state.treeId) return known.items;
    const entries = await this.optional(head.revision, `topics/${topic}`);
    const file = entries.find((entry) => entry.kind === "file" && entry.name === "open.md");
    let items: readonly OpenItem[] | null = null;
    if (file !== undefined && (file.size ?? 0) <= MAX_GENERATED_BYTES) {
      const text = await this.source.readFile(file).catch(() => null);
      items = text === null ? null : parseTopicOpen(text, topic);
    }
    this.openCache.set(topic, { treeId: state.treeId, items });
    return items;
  }

  /** The digest of a topic if it is already known for the current tree id; never fetches. */
  cachedDigest(topic: string): TopicDigest | null {
    const known = this.digests.get(topic);
    const state = this.states.get(topic);
    return known !== undefined && state !== undefined && known.treeId === state.treeId
      ? known.digest
      : null;
  }

  private async readDigest(revision: string, topic: string): Promise<TopicDigest> {
    const entries = await this.optional(revision, `topics/${topic}`);
    const index = entries.find((entry) => entry.kind === "file" && entry.name === "index.md");
    let parsed: TopicIndex | null = null;
    if (index !== undefined && (index.size ?? 0) <= MAX_GENERATED_BYTES) {
      parsed = parseTopicIndex(await this.source.readFile(index).catch(() => ""), topic);
    }
    if (parsed !== null && parsed.count !== null) {
      return {
        count: parsed.count,
        newestId: parsed.newestId,
        fromIndex: true,
        ids: parsed.rows.map((row) => row.id),
      };
    }
    return { count: null, newestId: await this.newestListed(revision, topic), fromIndex: false };
  }

  /** The newest message file name by listing: the newest month of the topic, newest file in it. */
  private async newestListed(revision: string, topic: string): Promise<string | null> {
    const months = (await this.optional(revision, `topics/${topic}/inbox`))
      .filter((entry) => entry.kind === "directory" && /^\d{4}-\d{2}$/.test(entry.name))
      .sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const month of months) {
      const files = (await this.optional(revision, month.path))
        .filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
        .sort((a, b) => (a.name < b.name ? 1 : -1));
      if (files[0] !== undefined) return files[0].name.slice(0, -".md".length);
    }
    return null;
  }

  private async optional(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    try {
      return await this.source.listDirectory(revision, path);
    } catch (error) {
      if (error instanceof SourceError && error.kind === "not-found") return [];
      throw error;
    }
  }

  private async read(head: Head): Promise<void> {
    const root = await this.source.listDirectory(head.revision, "");
    const metadata = await readRepositoryMetadata(this.source, root);
    const layout = metadata.layout;
    this.layout = layout;
    const states = new Map<string, TopicState>();
    if (layout === "topic") {
      const folders = await this.optional(head.revision, "topics");
      const rows = await this.rootIndex(root);
      const byName = new Map(rows.map((row) => [row.name, row]));
      for (const entry of folders) {
        if (entry.kind !== "directory" || !isTopicFolderName(entry.name)) continue;
        const row = byName.get(entry.name);
        states.set(entry.name, {
          treeId: entry.objectId,
          summary: {
            name: entry.name,
            title: row?.title ?? null,
            status: row?.status === "closed" ? "closed" : "open",
            folder: true,
          },
        });
      }
      for (const row of rows) {
        if (row.status !== "legacy" || states.has(row.name)) continue;
        states.set(row.name, {
          treeId: null,
          summary: { name: row.name, title: row.title, status: "legacy", folder: false },
        });
      }
    }
    this.states = new Map([...states].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    this.roster = {
      participants: metadata.participants,
      formerParticipants: metadata.formerParticipants,
      rosterKnown: metadata.rosterKnown,
    };
    this.head = head;
  }

  /** The root index rows, read again only when the file's object id changed. */
  private async rootIndex(
    root: readonly DirectoryEntry[],
  ): Promise<ReturnType<typeof parseRootIndex>> {
    const index = root.find((entry) => entry.kind === "file" && entry.name === "index.md");
    if (index === undefined || (index.size ?? 0) > MAX_GENERATED_BYTES) return [];
    if (this.indexCache?.objectId === index.objectId) return this.indexCache.rows;
    const rows = parseRootIndex(await this.source.readFile(index).catch(() => ""));
    this.indexCache = { objectId: index.objectId, rows };
    return rows;
  }

  /** The layout the marker named at the latest read. */
  get inboxLayout(): string {
    return this.layout;
  }
}

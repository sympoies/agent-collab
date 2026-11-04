// A viewing session of a topic-layout repository (docs/design/topics-and-scale.md, sections 6.2
// and 6.5): the topic list, a loader per opened topic and the generated-file digests, all kept in
// memory for the session and keyed by object id. A refresh looks at the `topics/` listing, and only
// a topic whose tree id changed is read again; an unchanged topic, closed or idle, costs nothing.
// Nothing here touches browser storage: a private repository stays in memory.

import { MAX_GENERATED_BYTES, parseTopicIndex, type TopicIndex } from "../message/generated-index";
import { isTopicFolderName, parseRootIndex, type TopicSummary } from "../message/topic-layout";
import { SourceError, type DirectoryEntry, type Head, type MessageSource } from "../source/types";
import type { Loader, LoaderOptions } from "./loader";
import { readLayout, topicLoader } from "./topic-reader";

/** What the viewer knows of a topic's size and recency without loading its messages. */
export interface TopicDigest {
  /** Messages, from the topic's `index.md`; null when the index could not be trusted. */
  readonly count: number | null;
  /** The newest message id, from the index or, failing that, the newest listed file name. */
  readonly newestId: string | null;
  readonly fromIndex: boolean;
}

interface TopicState {
  readonly summary: TopicSummary;
  /** Object id of `topics/<name>`; null for a legacy-only topic, which has no folder. */
  readonly treeId: string | null;
}

export class TopicSession {
  private head: Head | null = null;
  private states = new Map<string, TopicState>();
  private readonly loaders = new Map<string, { loader: Loader; treeId: string | null }>();
  private readonly digests = new Map<string, { treeId: string | null; digest: TopicDigest }>();
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
   * `topics/` listing is read again and only the opened topics whose tree id changed refresh their
   * loader; the others, closed or merely idle, make no request at all. Resolves to the names of
   * the topics that changed, new ones included.
   */
  async refresh(): Promise<readonly string[]> {
    if (this.head === null) {
      await this.open();
      return this.topics().map((topic) => topic.name);
    }
    const head = await this.source.head(this.head);
    if (head === "not-modified") return [];
    const before = this.states;
    await this.read(head);
    const changed: string[] = [];
    for (const [name, state] of this.states) {
      if (before.get(name)?.treeId !== state.treeId || before.get(name) === undefined) {
        changed.push(name);
      }
    }
    for (const name of before.keys()) if (!this.states.has(name)) changed.push(name);
    for (const name of changed) {
      const opened = this.loaders.get(name);
      if (opened === undefined) continue;
      // An opened topic with a new tree id reads its changes; one that was removed is dropped.
      if (this.states.has(name)) {
        opened.treeId = this.states.get(name)?.treeId ?? null;
        await opened.loader.refresh();
      } else {
        this.loaders.delete(name);
      }
    }
    return changed.sort();
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
    const digest = await this.readDigest(head.revision, topic);
    this.digests.set(topic, { treeId: state.treeId, digest });
    return digest;
  }

  private async readDigest(revision: string, topic: string): Promise<TopicDigest> {
    const entries = await this.optional(revision, `topics/${topic}`);
    const index = entries.find((entry) => entry.kind === "file" && entry.name === "index.md");
    let parsed: TopicIndex | null = null;
    if (index !== undefined && (index.size ?? 0) <= MAX_GENERATED_BYTES) {
      parsed = parseTopicIndex(await this.source.readFile(index).catch(() => ""), topic);
    }
    if (parsed !== null && parsed.count !== null) {
      return { count: parsed.count, newestId: parsed.newestId, fromIndex: true };
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
    const layout = await readLayout(this.source, root);
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

// The data layer of the Attention view (docs/design/topics-and-scale.md, section 6.3): what needs
// the viewer, across topics, at a cost the caller can read off the result. Nothing is followed by
// default. Each open topic that is read costs its tree and its `open.md` (two requests, cached by
// tree id); at most `ATTENTION_TOPIC_LIMIT` of the most recently active open topics are read unless
// the caller asks for all. A followed topic also loads its newest page of messages.

import type { OpenItem } from "../message/generated-index";
import type { Message } from "../message/types";
import type { TopicPreferences } from "../identity/topic-preferences";
import type { TopicSession } from "./topic-session";

/** A chosen default, not a measured value (design 6.3). */
export const ATTENTION_TOPIC_LIMIT = 30;

export interface AttentionRow {
  readonly topic: string;
  /** An untrusted row of the topic's `open.md`; opening it loads the message, which decides. */
  readonly item: OpenItem;
}

export interface AttentionMessage {
  readonly topic: string;
  readonly message: Message;
}

export interface Attention {
  /** Rows of `open.md` addressed to the viewer, topics in recency order. */
  readonly rows: readonly AttentionRow[];
  /** Messages addressed to the viewer in followed topics (their newest page). */
  readonly messages: readonly AttentionMessage[];
  /** Topics whose `open.md` was read. */
  readonly covered: readonly string[];
  /** Open topics left out by the limit; the caller can ask again with `all`. */
  readonly skipped: readonly string[];
  /** Topics with no usable `open.md` (an older tool): only their followed pages can be covered. */
  readonly withoutOpenFile: readonly string[];
  /** Followed topics whose newest page was loaded. */
  readonly followed: readonly string[];
}

export interface AttentionOptions {
  /** The person the viewer is; null for Observer, for whom nothing is addressed. */
  readonly viewer: string | null;
  readonly preferences: TopicPreferences;
  /** Read every open topic, not only the most recently active ones. */
  readonly all?: boolean;
  readonly limit?: number;
}

export async function loadAttention(
  session: TopicSession,
  options: AttentionOptions,
): Promise<Attention> {
  const muted = new Set(options.preferences.mute);
  const open = session
    .topics()
    .filter((topic) => topic.folder && topic.status === "open" && !muted.has(topic.name))
    .map((topic) => topic.name);
  const limit = options.limit ?? ATTENTION_TOPIC_LIMIT;

  // Recency is only needed to choose among more topics than the limit.
  let chosen = open;
  if (options.all !== true && open.length > limit) {
    const newest = new Map<string, string>();
    for (const topic of open) newest.set(topic, (await session.digest(topic)).newestId ?? "");
    chosen = [...open]
      .sort((a, b) => {
        const x = newest.get(a) ?? "";
        const y = newest.get(b) ?? "";
        return x === y ? (a < b ? -1 : 1) : x < y ? 1 : -1;
      })
      .slice(0, limit);
  }
  const chosenSet = new Set(chosen);

  const rows: AttentionRow[] = [];
  const covered: string[] = [];
  const withoutOpenFile: string[] = [];
  for (const topic of chosen) {
    const items = await session.openItems(topic);
    if (items === null) {
      withoutOpenFile.push(topic);
      continue;
    }
    covered.push(topic);
    if (options.viewer === null) continue;
    for (const item of items) {
      if (item.to.includes(options.viewer)) rows.push({ topic, item });
    }
  }

  const messages: AttentionMessage[] = [];
  const followed = options.preferences.follow.filter((topic) =>
    session.topics().some((known) => known.name === topic && known.folder),
  );
  for (const topic of followed) {
    const loader = session.loader(topic);
    if (loader.getSnapshot().items.length === 0) await loader.open();
    if (options.viewer === null) continue;
    for (const item of loader.getSnapshot().items) {
      if (item.kind === "message" && item.message.to.includes(options.viewer)) {
        messages.push({ topic, message: item.message });
      }
    }
  }

  return {
    rows,
    messages,
    covered,
    skipped: open.filter((topic) => !chosenSet.has(topic)),
    withoutOpenFile,
    followed,
  };
}

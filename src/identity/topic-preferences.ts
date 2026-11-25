// Per-viewer, per-repository topic state (docs/design/topics-and-scale.md, section 6.4): follow,
// mute, pin, hide and the last-seen message id of each topic. Local only: it holds topic names and
// message ids, never message text, and storage may be missing or throw, in which case the view
// works from memory. Same guarded pattern as the identity preferences.

import { parseId } from "../message/generated-index";
import type { PreferenceStorage } from "./preferences";

const KEY_PREFIX = "agent-collab-viewer.topics:";
const MAX_TOPICS = 500;
const TOPIC_RE = /^[a-z0-9-]{1,64}$/;

export type TopicList = "follow" | "mute" | "pin" | "hide";

export interface SeenMarker {
  /** One id at the newest timestamp that was visible. */
  readonly id: string;
  /** Every visible id at that minute; IDs from different senders are not chronologically ordered. */
  readonly ids: readonly string[];
}

export interface TopicPreferences {
  /** Topics whose newest page Attention loads (default: none). */
  readonly follow: readonly string[];
  /** Topics Attention and notifications leave out; counters stay. */
  readonly mute: readonly string[];
  /** Topics that stay at the top of the list. */
  readonly pin: readonly string[];
  /** Topics that are not listed (reachable from a "Hidden" row). */
  readonly hide: readonly string[];
  /** Newest visible timestamp and its visible message ids, per topic. */
  readonly seen: Readonly<Record<string, SeenMarker>>;
}

export const EMPTY_TOPIC_PREFERENCES: TopicPreferences = {
  follow: [],
  mute: [],
  pin: [],
  hide: [],
  seen: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function names(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const valid = value.filter(
    (item): item is string => typeof item === "string" && TOPIC_RE.test(item),
  );
  return [...new Set(valid)].slice(0, MAX_TOPICS).sort();
}

/** The last-seen marker; own properties only, so `constructor` is a topic name. */
export function seenOf(preferences: TopicPreferences, topic: string): SeenMarker | undefined {
  return Object.hasOwn(preferences.seen, topic) ? preferences.seen[topic] : undefined;
}

function timePrefix(id: string): string {
  return id.slice(0, 13);
}

function belongsToTopic(id: string, topic: string): boolean {
  return parseId(id)?.senderAndTopic.endsWith(`-${topic}`) === true;
}

/** Keeps only well-formed entries, so a damaged or foreign value never breaks the view. */
function sanitize(value: unknown): TopicPreferences {
  if (!isRecord(value)) return EMPTY_TOPIC_PREFERENCES;
  const seenEntries: [string, SeenMarker][] = [];
  if (isRecord(value.seen)) {
    for (const [topic, marker] of Object.entries(value.seen).slice(0, MAX_TOPICS)) {
      if (typeof marker === "string" && belongsToTopic(marker, topic)) {
        seenEntries.push([topic, { id: marker, ids: [marker] }]);
        continue;
      }
      if (
        !TOPIC_RE.test(topic) ||
        !isRecord(marker) ||
        typeof marker.id !== "string" ||
        !belongsToTopic(marker.id, topic) ||
        !Array.isArray(marker.ids)
      ) {
        continue;
      }
      const prefix = timePrefix(marker.id);
      const ids = marker.ids.filter(
        (id): id is string =>
          typeof id === "string" && belongsToTopic(id, topic) && timePrefix(id) === prefix,
      );
      if (!ids.includes(marker.id)) ids.push(marker.id);
      seenEntries.push([topic, { id: marker.id, ids: [...new Set(ids)].sort() }]);
    }
  }
  const seen = Object.fromEntries(seenEntries);
  const follow = names(value.follow);
  const mute = names(value.mute).filter((topic) => !follow.includes(topic));
  const hide = names(value.hide);
  return {
    follow,
    mute,
    hide,
    pin: names(value.pin).filter((topic) => !hide.includes(topic)),
    seen,
  };
}

export function readTopicPreferences(
  storage: PreferenceStorage | null,
  repositoryKey: string,
): TopicPreferences {
  if (storage === null) return EMPTY_TOPIC_PREFERENCES;
  try {
    const text = storage.getItem(`${KEY_PREFIX}${repositoryKey}`);
    return text === null ? EMPTY_TOPIC_PREFERENCES : sanitize(JSON.parse(text));
  } catch {
    return EMPTY_TOPIC_PREFERENCES;
  }
}

/** Returns whether the preferences were saved; the view works from memory either way. */
export function writeTopicPreferences(
  storage: PreferenceStorage | null,
  repositoryKey: string,
  preferences: TopicPreferences,
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(`${KEY_PREFIX}${repositoryKey}`, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

/** The opposite choices: following a topic unmutes it, hiding it unpins it, and the reverse. */
const EXCLUDES: Record<TopicList, TopicList | null> = {
  follow: "mute",
  mute: "follow",
  hide: "pin",
  pin: "hide",
};

/** Turns one list on or off for a topic; a name that is not a topic name changes nothing. */
export function toggleTopic(
  preferences: TopicPreferences,
  list: TopicList,
  topic: string,
  on: boolean,
): TopicPreferences {
  if (!TOPIC_RE.test(topic)) return preferences;
  const without = (items: readonly string[]) => items.filter((item) => item !== topic);
  const excluded = EXCLUDES[list];
  const next: TopicPreferences = {
    ...preferences,
    [list]: on
      ? [...new Set([...without(preferences[list]), topic])].sort()
      : without(preferences[list]),
  };
  return on && excluded !== null ? { ...next, [excluded]: without(next[excluded]) } : next;
}

/** Records all visible ids at the newest visible timestamp; the marker only moves forward. */
export function markSeen(
  preferences: TopicPreferences,
  topic: string,
  id: string,
  visibleIds: readonly string[],
): TopicPreferences {
  if (!TOPIC_RE.test(topic) || !belongsToTopic(id, topic)) return preferences;
  const prefix = timePrefix(id);
  const known = seenOf(preferences, topic);
  if (known !== undefined && timePrefix(known.id) > prefix) return preferences;
  const ids = visibleIds.filter(
    (candidate) => belongsToTopic(candidate, topic) && timePrefix(candidate) === prefix,
  );
  ids.push(id);
  const nextIds = [
    ...new Set([
      ...(known !== undefined && timePrefix(known.id) === prefix ? known.ids : []),
      ...ids,
    ]),
  ].sort();
  if (known?.id === id && known.ids.length === nextIds.length) return preferences;
  const others = Object.entries(preferences.seen).filter(([name]) => name !== topic);
  return {
    ...preferences,
    seen: Object.fromEntries([...others, [topic, { id, ids: nextIds }]]),
  };
}

/**
 * The preferences restricted to topics that still exist. A topic that disappeared is ignored, not
 * forgotten: stored state stays in case it comes back.
 */
export function forExistingTopics(
  preferences: TopicPreferences,
  topics: readonly string[],
): TopicPreferences {
  const exist = new Set(topics);
  const keep = (items: readonly string[]) => items.filter((item) => exist.has(item));
  return {
    follow: keep(preferences.follow),
    mute: keep(preferences.mute),
    pin: keep(preferences.pin),
    hide: keep(preferences.hide),
    seen: Object.fromEntries(
      Object.entries(preferences.seen).filter(([topic]) => exist.has(topic)),
    ),
  };
}

export interface Unread {
  /** True when the topic has a message newer than the last-seen marker. */
  readonly unread: boolean;
  /** How many, when the topic's index lists its ids; null when only the newest id is known. */
  readonly count: number | null;
}

/** The known message ids for a legacy topic, or null when none are loaded. */
export function legacyUnreadDigest(
  messages: readonly { readonly topic: string; readonly id: string }[],
  topic: string,
  complete: boolean,
): {
  readonly newestId: string;
  readonly ids: readonly string[];
  readonly idsComplete: boolean;
} | null {
  const ids = messages
    .filter((message) => message.topic === topic)
    .map((message) => message.id)
    .sort();
  const newestId = ids.at(-1);
  return newestId === undefined ? null : { newestId, ids, idsComplete: complete };
}

/**
 * Unread state from what the digest knows: the newest id (and the ids, when the index could be
 * trusted) against the last-seen marker. A topic never seen counts everything as unread.
 */
export function unreadOf(
  preferences: TopicPreferences,
  topic: string,
  digest: {
    readonly newestId: string | null;
    readonly ids?: readonly string[] | null;
    readonly idsComplete?: boolean;
  },
): Unread {
  const seen = seenOf(preferences, topic);
  const newestId = digest.newestId;
  if (newestId === null) return { unread: false, count: 0 };
  if (seen === undefined) {
    if (digest.ids === undefined || digest.ids === null || digest.idsComplete === false) {
      return { unread: true, count: null };
    }
    return { unread: true, count: digest.ids.length };
  }

  const seenTime = timePrefix(seen.id);
  const newestTime = timePrefix(newestId);
  if (newestTime < seenTime) return { unread: false, count: 0 };
  if (digest.ids === undefined || digest.ids === null) {
    if (newestTime > seenTime || !seen.ids.includes(newestId)) {
      return { unread: true, count: null };
    }
    return { unread: false, count: 0 };
  }

  const unseen = digest.ids.filter((id) => {
    const messageTime = timePrefix(id);
    return messageTime > seenTime || (messageTime === seenTime && !seen.ids.includes(id));
  });
  if (digest.idsComplete === false) {
    const oldestTime = digest.ids[0] === undefined ? null : timePrefix(digest.ids[0]);
    if (
      oldestTime === null ||
      oldestTime > seenTime ||
      (oldestTime === seenTime && !digest.ids.includes(seen.id))
    ) {
      return { unread: true, count: null };
    }
  }
  return { unread: unseen.length > 0, count: unseen.length };
}

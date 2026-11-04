import { describe, expect, it } from "vitest";

import {
  EMPTY_TOPIC_PREFERENCES,
  forExistingTopics,
  markSeen,
  readTopicPreferences,
  toggleTopic,
  unreadOf,
  writeTopicPreferences,
  type TopicPreferences,
} from "../src/identity/topic-preferences";
import type { PreferenceStorage } from "../src/identity/preferences";

const ID = (day: number, topic = "api") =>
  `2026-11-${String(day).padStart(2, "0")}T0900-alice-agent-${topic}-01`;

function memory(): PreferenceStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

const throwing: PreferenceStorage = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

const prefs = (over: Partial<TopicPreferences>): TopicPreferences => ({
  ...EMPTY_TOPIC_PREFERENCES,
  ...over,
});

describe("topic preferences storage", () => {
  it("saves and restores, one record per repository", () => {
    const storage = memory();
    const a = prefs({ follow: ["api"], pin: ["ops"], seen: { api: ID(3) } });
    expect(writeTopicPreferences(storage, "github:one", a)).toBe(true);
    expect(readTopicPreferences(storage, "github:one")).toEqual(a);
    // Another repository with the same topic names stays separate.
    expect(readTopicPreferences(storage, "github:two")).toEqual(EMPTY_TOPIC_PREFERENCES);
    writeTopicPreferences(storage, "github:two", prefs({ mute: ["api"] }));
    expect(readTopicPreferences(storage, "github:one").follow).toEqual(["api"]);
    expect(readTopicPreferences(storage, "github:two")).toMatchObject({
      follow: [],
      mute: ["api"],
    });
  });

  it("works from memory when storage is missing, throws on read or on write, or is full", () => {
    expect(readTopicPreferences(null, "k")).toEqual(EMPTY_TOPIC_PREFERENCES);
    expect(readTopicPreferences(throwing, "k")).toEqual(EMPTY_TOPIC_PREFERENCES);
    expect(writeTopicPreferences(null, "k", EMPTY_TOPIC_PREFERENCES)).toBe(false);
    expect(writeTopicPreferences(throwing, "k", EMPTY_TOPIC_PREFERENCES)).toBe(false);
  });

  it("ignores corrupt, foreign and hostile stored data without breaking", () => {
    const storage = memory();
    const key = "agent-collab-viewer.topics:k";
    for (const text of ["{not json", "null", "[]", '"text"', "42", "{}"]) {
      storage.values.set(key, text);
      expect(readTopicPreferences(storage, "k"), text).toEqual(EMPTY_TOPIC_PREFERENCES);
    }
    storage.values.set(
      key,
      JSON.stringify({
        follow: ["api", "Bad Name", 7, null, "../x", "api", "a".repeat(100)],
        mute: "api",
        pin: [{}],
        hide: ["ops"],
        // Message text or anything else that is not an id is never kept.
        seen: { api: "a secret message body", ops: ID(2, "ops"), Bad: ID(1), x: 5 },
        extra: { text: "kept nowhere" },
      }),
    );
    expect(readTopicPreferences(storage, "k")).toEqual({
      follow: ["api"],
      mute: [],
      pin: [],
      hide: ["ops"],
      seen: { ops: ID(2, "ops") },
    });
  });

  it("caps what it reads, and the follow/mute and pin/hide pairs cannot both be set", () => {
    const storage = memory();
    const many = Array.from({ length: 2000 }, (_, i) => `t${String(i)}`);
    storage.values.set(
      "agent-collab-viewer.topics:k",
      JSON.stringify({ follow: many, mute: ["t1", "zz"], pin: ["p", "h"], hide: ["h"] }),
    );
    const read = readTopicPreferences(storage, "k");
    expect(read.follow).toHaveLength(500);
    // follow wins over mute, hide wins over pin.
    expect(read.mute).toEqual(["zz"]);
    expect(read.pin).toEqual(["p"]);
  });

  it("stores only names and ids, never text", () => {
    const storage = memory();
    writeTopicPreferences(storage, "k", markSeen(EMPTY_TOPIC_PREFERENCES, "api", ID(3)));
    expect([...storage.values.values()].join()).not.toMatch(/Synthetic|body|summary/);
    expect(JSON.parse([...storage.values.values()][0] ?? "{}")).toEqual({
      follow: [],
      mute: [],
      pin: [],
      hide: [],
      seen: { api: ID(3) },
    });
  });
});

describe("changing topic preferences", () => {
  it("turns lists on and off, sorted and without duplicates", () => {
    let p = EMPTY_TOPIC_PREFERENCES;
    p = toggleTopic(p, "follow", "ops", true);
    p = toggleTopic(p, "follow", "api", true);
    p = toggleTopic(p, "follow", "api", true);
    expect(p.follow).toEqual(["api", "ops"]);
    p = toggleTopic(p, "follow", "api", false);
    expect(p.follow).toEqual(["ops"]);
  });

  it("following unmutes, muting unfollows, hiding unpins and pinning unhides", () => {
    let p = toggleTopic(EMPTY_TOPIC_PREFERENCES, "mute", "api", true);
    p = toggleTopic(p, "follow", "api", true);
    expect(p).toMatchObject({ follow: ["api"], mute: [] });
    p = toggleTopic(p, "mute", "api", true);
    expect(p).toMatchObject({ follow: [], mute: ["api"] });
    p = toggleTopic(p, "pin", "api", true);
    p = toggleTopic(p, "hide", "api", true);
    expect(p).toMatchObject({ pin: [], hide: ["api"] });
    p = toggleTopic(p, "pin", "api", true);
    expect(p).toMatchObject({ pin: ["api"], hide: [] });
    // Turning one off does not switch the other on.
    expect(toggleTopic(p, "pin", "api", false)).toMatchObject({ pin: [], hide: [] });
  });

  it("refuses a name that is not a topic name", () => {
    for (const bad of ["", "Api", "a b", "../x", "x".repeat(65)]) {
      expect(toggleTopic(EMPTY_TOPIC_PREFERENCES, "follow", bad, true)).toBe(
        EMPTY_TOPIC_PREFERENCES,
      );
    }
  });

  it("moves the last-seen marker only forward, and only to a real id", () => {
    let p = markSeen(EMPTY_TOPIC_PREFERENCES, "api", ID(5));
    expect(markSeen(p, "api", ID(3))).toBe(p);
    expect(markSeen(p, "api", ID(5))).toBe(p);
    p = markSeen(p, "api", ID(6));
    expect(p.seen).toEqual({ api: ID(6) });
    expect(markSeen(p, "api", "not an id")).toBe(p);
    expect(markSeen(p, "Bad Name", ID(7))).toBe(p);
  });

  it("ignores a topic that disappeared without forgetting it", () => {
    const stored = prefs({
      follow: ["api", "gone"],
      pin: ["gone"],
      seen: { gone: ID(2, "gone"), api: ID(1) },
    });
    const visible = forExistingTopics(stored, ["api", "ops"]);
    expect(visible).toEqual({ follow: ["api"], mute: [], pin: [], hide: [], seen: { api: ID(1) } });
    // The stored record is untouched, so the topic's state returns with it.
    expect(stored.follow).toEqual(["api", "gone"]);
    expect(forExistingTopics(stored, ["api", "gone"]).follow).toEqual(["api", "gone"]);
  });
});

describe("unread counters", () => {
  const ids = [ID(1), ID(2), ID(3)];

  it("compares the newest id with the last-seen marker", () => {
    expect(unreadOf(prefs({ seen: { api: ID(3) } }), "api", { newestId: ID(3), ids })).toEqual({
      unread: false,
      count: 0,
    });
    expect(unreadOf(prefs({ seen: { api: ID(1) } }), "api", { newestId: ID(3), ids })).toEqual({
      unread: true,
      count: 2,
    });
  });

  it("counts everything for a topic never seen, and nothing for an empty one", () => {
    expect(unreadOf(EMPTY_TOPIC_PREFERENCES, "api", { newestId: ID(3), ids })).toEqual({
      unread: true,
      count: 3,
    });
    expect(unreadOf(EMPTY_TOPIC_PREFERENCES, "api", { newestId: null, ids: [] })).toEqual({
      unread: false,
      count: 0,
    });
  });

  it("knows only that something is new when the index could not give the ids", () => {
    expect(unreadOf(prefs({ seen: { api: ID(1) } }), "api", { newestId: ID(3) })).toEqual({
      unread: true,
      count: null,
    });
    expect(
      unreadOf(prefs({ seen: { api: ID(1) } }), "api", { newestId: ID(3), ids: null }),
    ).toEqual({
      unread: true,
      count: null,
    });
  });
});

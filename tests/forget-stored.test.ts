import { describe, expect, it } from "vitest";

import { forgetStored, isForgettable } from "../src/settings/forget-stored";

function storage(entries: Record<string, string>) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("forgetStored", () => {
  it("removes what the viewer remembers and keeps language, theme and foreign keys", () => {
    const store = storage({
      "agent-collab-viewer.settings": "{}",
      "agent-collab-viewer.identity:hosted:https://a.example/": "{}",
      "agent-collab-viewer.identity:local:clone": "{}",
      "agent-collab-viewer.view:local:clone": "{}",
      "agent-collab-viewer.topics:github:x": "{}",
      "agent-collab-viewer.identity-hint:github:x": "{}",
      "agent-collab-viewer.questions.expanded:x": "{}",
      "agent-collab-viewer.locale": "ja",
      "agent-collab-viewer.theme": "night-owl",
      "another-app.key": "keep",
    });
    forgetStored(store);
    expect([...store.values.keys()].sort()).toEqual([
      "agent-collab-viewer.locale",
      "agent-collab-viewer.theme",
      "another-app.key",
    ]);
  });

  it("does nothing for an empty store and survives a store that throws", () => {
    forgetStored(storage({}));
    const throwing = {
      length: 1,
      key: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => {
      forgetStored(throwing);
    }).not.toThrow();
  });

  it("names the keys it forgets, for storage kept in memory too", () => {
    expect(isForgettable("agent-collab-viewer.view:local:x")).toBe(true);
    expect(isForgettable("agent-collab-viewer.locale")).toBe(false);
    expect(isForgettable("agent-collab-viewer.theme")).toBe(false);
    expect(isForgettable("other.key")).toBe(false);
  });
});

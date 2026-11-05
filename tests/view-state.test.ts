import { describe, expect, it } from "vitest";

import { readViewState, writeViewState } from "../src/identity/view-state";

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("view state", () => {
  it("starts on All in the chat when nothing was stored or there is no storage", () => {
    expect(readViewState(memory(), "hosted:a")).toEqual({ view: "chat", topic: null });
    expect(readViewState(null, "hosted:a")).toEqual({ view: "chat", topic: null });
  });

  it("returns what was written, per key", () => {
    const storage = memory();
    expect(writeViewState(storage, "hosted:a", { view: "files", topic: "api" })).toBe(true);
    expect(readViewState(storage, "hosted:a")).toEqual({ view: "files", topic: "api" });
    expect(readViewState(storage, "hosted:b")).toEqual({ view: "chat", topic: null });
  });

  it("ignores damaged or foreign values", () => {
    for (const text of ["{", "[]", '{"view":"x","topic":"../etc"}', '{"view":"chat","topic":7}']) {
      const storage = memory({ "agent-collab-viewer.view:k": text });
      expect(readViewState(storage, "k")).toEqual({ view: "chat", topic: null });
    }
  });

  it("works from memory when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readViewState(throwing, "k")).toEqual({ view: "chat", topic: null });
    expect(writeViewState(throwing, "k", { view: "chat", topic: null })).toBe(false);
  });

  it("stores only the view and the topic name", () => {
    const storage = memory();
    writeViewState(storage, "k", { view: "questions", topic: "api" });
    expect(JSON.parse(storage.values.get("agent-collab-viewer.view:k") as string)).toEqual({
      view: "questions",
      topic: "api",
    });
  });
});

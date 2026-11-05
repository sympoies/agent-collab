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
    expect(readViewState(memory(), "hosted:a")).toEqual({
      view: "chat",
      topic: null,
      conversation: false,
    });
    expect(readViewState(null, "hosted:a")).toEqual({
      view: "chat",
      topic: null,
      conversation: false,
    });
  });

  it("returns what was written, per key", () => {
    const storage = memory();
    expect(
      writeViewState(storage, "hosted:a", {
        view: "files",
        topic: "api",
        conversation: true,
      }),
    ).toBe(true);
    expect(readViewState(storage, "hosted:a")).toEqual({
      view: "files",
      topic: "api",
      conversation: true,
    });
    expect(readViewState(storage, "hosted:b")).toEqual({
      view: "chat",
      topic: null,
      conversation: false,
    });
  });

  it("ignores damaged or foreign values", () => {
    for (const text of [
      "{",
      "[]",
      '{"view":"x","topic":null}',
      '{"view":"chat","topic":"../etc"}',
      '{"view":"chat","topic":7}',
    ]) {
      const storage = memory({ "agent-collab-viewer.view:k": text });
      expect(readViewState(storage, "k")).toEqual({
        view: "chat",
        topic: null,
        conversation: false,
      });
    }
  });

  it("treats a conversation flag that is not a boolean as the list", () => {
    const storage = memory({
      "agent-collab-viewer.view:k": '{"view":"chat","topic":"api","conversation":"yes"}',
    });
    expect(readViewState(storage, "k")).toEqual({
      view: "chat",
      topic: "api",
      conversation: false,
    });
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
    expect(readViewState(throwing, "k")).toEqual({
      view: "chat",
      topic: null,
      conversation: false,
    });
    expect(writeViewState(throwing, "k", { view: "chat", topic: null, conversation: false })).toBe(
      false,
    );
  });

  it("stores only the view and the topic name", () => {
    const storage = memory();
    writeViewState(storage, "k", { view: "questions", topic: "api", conversation: true });
    expect(JSON.parse(storage.values.get("agent-collab-viewer.view:k") as string)).toEqual({
      view: "questions",
      topic: "api",
      conversation: true,
    });
  });
});

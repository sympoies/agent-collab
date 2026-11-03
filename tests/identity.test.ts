import { describe, expect, it } from "vitest";

import {
  assignSlots,
  colorOrder,
  EMPTY_PREFERENCES,
  PALETTE_SIZE,
  readPreferences,
  resetProfile,
  resolveViewer,
  withColor,
  withDisplayName,
  withViewingAs,
  writePreferences,
  type PreferenceStorage,
} from "../src/identity/preferences";
import { buildPeople } from "../src/ui/people";

const KEY = "github:https://api.github.com/alice-org/collab";

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & {
  readonly values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

const throwingStorage: PreferenceStorage = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("identity preferences storage", () => {
  it("round-trips the choices per repository", () => {
    const storage = memoryStorage();
    const saved = withDisplayName(
      withColor(withViewingAs(EMPTY_PREFERENCES, "bob-agent"), "alice-agent", 4),
      "alice-agent",
      "  Alice  ",
    );
    expect(writePreferences(storage, KEY, saved)).toBe(true);
    expect(readPreferences(storage, KEY)).toEqual({
      viewingAs: "bob-agent",
      colors: { "alice-agent": 4 },
      names: { "alice-agent": "Alice" },
    });
    expect(readPreferences(storage, `${KEY}-other`)).toEqual(EMPTY_PREFERENCES);
  });

  it("works without storage: missing, throwing on read, or throwing on write", () => {
    expect(readPreferences(null, KEY)).toEqual(EMPTY_PREFERENCES);
    expect(readPreferences(throwingStorage, KEY)).toEqual(EMPTY_PREFERENCES);
    expect(writePreferences(null, KEY, EMPTY_PREFERENCES)).toBe(false);
    expect(writePreferences(throwingStorage, KEY, withViewingAs(EMPTY_PREFERENCES, null))).toBe(
      false,
    );
  });

  it("drops damaged or foreign values instead of failing", () => {
    const stored = (value: unknown) =>
      readPreferences(
        memoryStorage({ [`agent-collab-viewer.identity:${KEY}`]: JSON.stringify(value) }),
        KEY,
      );
    expect(
      readPreferences(memoryStorage({ [`agent-collab-viewer.identity:${KEY}`]: "{not json" }), KEY),
    ).toEqual(EMPTY_PREFERENCES);
    expect(stored(["a"])).toEqual(EMPTY_PREFERENCES);
    expect(
      stored({
        viewingAs: "Not A Name",
        colors: { "alice-agent": 99, "bob-agent": 1.5, "carol-agent": 2, "Bad Name": 3 },
        names: { "alice-agent": "\u0007  ", "bob-agent": 5, "carol-agent": "x".repeat(100) },
      }),
    ).toEqual({
      viewingAs: undefined,
      colors: { "carol-agent": 2 },
      names: { "carol-agent": "x".repeat(40) },
    });
  });
});

describe("Viewing as", () => {
  const roster = ["alice-agent", "bob-agent"];

  it("uses the saved participant, and Observer when that was chosen", () => {
    expect(resolveViewer(withViewingAs(EMPTY_PREFERENCES, "bob-agent"), roster, [])).toBe(
      "bob-agent",
    );
    expect(
      resolveViewer(withViewingAs(EMPTY_PREFERENCES, null), roster, ["alice-agent"]),
    ).toBeNull();
  });

  it("defaults to the first configured own name that is a participant, else Observer", () => {
    expect(resolveViewer(EMPTY_PREFERENCES, roster, ["carol-agent", "bob-agent"])).toBe(
      "bob-agent",
    );
    expect(resolveViewer(EMPTY_PREFERENCES, roster, ["carol-agent"])).toBeNull();
    expect(resolveViewer(EMPTY_PREFERENCES, [], ["alice-agent"])).toBeNull();
  });

  it("ignores a saved person who is not a participant, and takes them back when they return", () => {
    const saved = withViewingAs(EMPTY_PREFERENCES, "carol-agent");
    expect(resolveViewer(saved, roster, ["alice-agent"])).toBe("alice-agent");
    expect(resolveViewer(saved, [...roster, "carol-agent"], ["alice-agent"])).toBe("carol-agent");
  });
});

describe("person colors", () => {
  it("assigns defaults in roster order, then former participants, then other senders by name", () => {
    expect(
      colorOrder(["bob-agent", "alice-agent"], ["dave-agent"], ["zed-agent", "alice-agent", "abe"]),
    ).toEqual(["bob-agent", "alice-agent", "dave-agent", "abe", "zed-agent"]);
  });

  it("wraps the default assignment around the palette", () => {
    const order = Array.from({ length: PALETTE_SIZE + 2 }, (_, index) => `person-${String(index)}`);
    const slots = assignSlots(order, EMPTY_PREFERENCES);
    expect(slots.get("person-0")).toBe(0);
    expect(slots.get(`person-${String(PALETTE_SIZE - 1)}`)).toBe(PALETTE_SIZE - 1);
    expect(slots.get(`person-${String(PALETTE_SIZE)}`)).toBe(0);
    expect(slots.get(`person-${String(PALETTE_SIZE + 1)}`)).toBe(1);
  });

  it("keeps an override by name through a roster change, and Reset restores the defaults", () => {
    const overridden = withColor(EMPTY_PREFERENCES, "bob-agent", 6);
    expect(assignSlots(["alice-agent", "bob-agent"], overridden).get("bob-agent")).toBe(6);
    // A new participant ahead of bob shifts bob's default but not the override.
    expect(
      assignSlots(["carol-agent", "alice-agent", "bob-agent"], overridden).get("bob-agent"),
    ).toBe(6);
    expect(assignSlots(["alice-agent"], overridden).has("bob-agent")).toBe(false);

    const reset = resetProfile(
      withDisplayName(withViewingAs(overridden, "alice-agent"), "bob-agent", "Bob"),
    );
    expect(reset).toEqual({ viewingAs: "alice-agent", colors: {}, names: {} });
    expect(assignSlots(["alice-agent", "bob-agent"], reset).get("bob-agent")).toBe(1);
  });

  it("rejects an out-of-range slot and clears an override with null", () => {
    expect(withColor(EMPTY_PREFERENCES, "bob-agent", PALETTE_SIZE).colors).toEqual({});
    expect(
      withColor(withColor(EMPTY_PREFERENCES, "bob-agent", 2), "bob-agent", null).colors,
    ).toEqual({});
  });

  it("shows the local display name, falling back to the participant name", () => {
    const people = buildPeople(
      ["alice-agent", "bob-agent"],
      withDisplayName(EMPTY_PREFERENCES, "alice-agent", "Alice"),
    );
    expect(people.label("alice-agent")).toBe("Alice");
    expect(people.label("bob-agent")).toBe("bob-agent");
    expect(people.slot("bob-agent")).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import type { LoaderSnapshot } from "../src/loader/loader";
import { mergeSnapshots } from "../src/ui/merged-snapshot";

const snapshot = (incompleteTopics: LoaderSnapshot["incompleteTopics"]): LoaderSnapshot => ({
  items: [],
  hasOlder: false,
  jumpedTo: null,
  fresh: new Set(),
  participants: ["alice-agent", "bob-agent"],
  formerParticipants: [],
  rosterKnown: true,
  incompleteTopics,
  lastChanged: null,
  lastChangedBy: null,
});

describe("merging the unloaded ids of several topic loaders", () => {
  it("keeps the newest id of each topic and every topic of any source", () => {
    const merged = mergeSnapshots([
      snapshot({
        api: "2026-10-01T0800-alice-agent-api-01",
        ops: "2026-10-01T0700-alice-agent-ops-01",
      }),
      snapshot({ api: "2026-10-01T0900-alice-agent-api-01" }),
    ]);
    expect(merged.incompleteTopics).toEqual({
      api: "2026-10-01T0900-alice-agent-api-01",
      ops: "2026-10-01T0700-alice-agent-ops-01",
    });
  });

  it("is unknown for every topic when one source cannot tell", () => {
    expect(
      mergeSnapshots([snapshot({ api: "2026-10-01T0800-alice-agent-api-01" }), snapshot(null)])
        .incompleteTopics,
    ).toBeNull();
  });
});

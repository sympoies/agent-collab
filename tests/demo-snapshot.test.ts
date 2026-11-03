import { describe, expect, it, vi } from "vitest";

import { LiveCheckGate, openLiveDemo } from "../src/settings/live-demo";
import { parseDemoSnapshot, type DemoSnapshot } from "../src/settings/demo-snapshot";
import { FixtureSource } from "../src/source/fixture";
import { SourceError } from "../src/source/types";

const snapshot: DemoSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-11-03T08:00:00.000Z",
  revision: "tree-sha",
  files: [
    { path: ".agent-collab", text: "collab-protocol: 1\n" },
    {
      path: "inbox/2026-11-03T0900-alice-agent-api-01.md",
      text: [
        "---",
        "id: 2026-11-03T0900-alice-agent-api-01",
        "from: alice-agent",
        "to:",
        "topic: api",
        "type: info",
        "reply_to:",
        "refs:",
        "needs: none",
        "due:",
        "---",
        "Snapshot message.",
      ].join("\n"),
    },
  ],
};

describe("demo snapshots", () => {
  it("accepts the generated format and rejects unsafe or duplicate paths", () => {
    expect(parseDemoSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(
      parseDemoSnapshot(
        JSON.stringify({
          ...snapshot,
          files: [...snapshot.files, { path: "topics/../escape.md", text: "bad" }],
        }),
      ),
    ).toBeNull();
    expect(
      parseDemoSnapshot(
        JSON.stringify({ ...snapshot, files: [...snapshot.files, snapshot.files[0]] }),
      ),
    ).toBeNull();
    expect(parseDemoSnapshot("not json")).toBeNull();
  });

  it("chooses the snapshot before the anonymous API source", async () => {
    const createApiSource = vi.fn(() => new FixtureSource({}));
    const opened = await openLiveDemo(createApiSource, {}, new LiveCheckGate(), () =>
      Promise.resolve(snapshot),
    );
    expect(createApiSource).not.toHaveBeenCalled();
    expect(opened.view).toEqual({ kind: "snapshot", generatedAt: snapshot.generatedAt });
    expect(opened.loader.getSnapshot().items.map((item) => item.kind)).toEqual(["message"]);
  });

  it("tries the API when the snapshot is absent and falls back to the bundled sample on rate limit", async () => {
    const retryAt = new Date("2026-11-03T12:00:00.000Z");
    const rateLimited: FixtureSource = new FixtureSource({});
    vi.spyOn(rateLimited, "head").mockRejectedValue(
      new SourceError("rate-limited", "", 403, retryAt),
    );
    const bundledMessage = {
      path: "inbox/2026-11-03T0901-bob-agent-api-01.md",
      text:
        snapshot.files[1]?.text.replaceAll("alice-agent", "bob-agent").replaceAll("0900", "0901") ??
        "",
    };
    const createApiSource = vi.fn(() => rateLimited);
    const opened = await openLiveDemo(
      createApiSource,
      { ".agent-collab": "collab-protocol: 1\n", [bundledMessage.path]: bundledMessage.text },
      new LiveCheckGate(),
      () => Promise.resolve(null),
    );
    expect(createApiSource).toHaveBeenCalledOnce();
    expect(opened.view).toEqual({ kind: "bundled" });
    expect(opened.banner).toContain("Next live check");
    expect(opened.loader.getSnapshot().items).toHaveLength(1);
  });
});

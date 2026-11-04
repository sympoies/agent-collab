import { describe, expect, it, vi } from "vitest";

import { Loader } from "../src/loader/loader";
import { TopicSession } from "../src/loader/topic-session";
import { DemoSnapshotSource, parseDemoSnapshot } from "../src/settings/demo-snapshot";
import { LiveCheckGate, openLiveDemo } from "../src/settings/live-demo";
import { SourceError } from "../src/source/types";
import { presenterEn } from "./support";
import {
  API_IDS,
  LEGACY_API_ID,
  LEGACY_ONLY_ID,
  REFERENCING_ID,
  topicSnapshot,
} from "./topic-snapshot-fixture";

const messageIds = (loader: Loader) =>
  loader.getSnapshot().items.flatMap((item) => (item.kind === "message" ? [item.message.id] : []));

describe("listing-only snapshot files", () => {
  const base = {
    schemaVersion: 1,
    generatedAt: "2026-11-04T08:00:00.000Z",
    revision: "tree",
  };
  const marker = { path: ".agent-collab", text: "collab-protocol: 1\n" };

  it("accepts a well-formed listing-only file and rejects malformed ones", () => {
    const parse = (file: unknown) =>
      parseDemoSnapshot(JSON.stringify({ ...base, files: [marker, file] }));
    expect(
      parse({ path: "topics/api/a.png", text: "", omitted: true, size: 12 })?.files[1],
    ).toEqual({
      path: "topics/api/a.png",
      text: "",
      omitted: true,
      size: 12,
    });
    expect(parse({ path: "topics/api/a.png", text: "x", omitted: true, size: 12 })).toBeNull();
    expect(parse({ path: "topics/api/a.png", text: "", omitted: true, size: -1 })).toBeNull();
    expect(parse({ path: "topics/api/a.png", text: "", omitted: true })).toBeNull();
    expect(parse({ path: "topics/api/a.png", text: "", omitted: false, size: 1 })).toBeNull();
  });

  it("lists them with their size and refuses to read their content", async () => {
    const snapshot = await topicSnapshot();
    const source = new DemoSnapshotSource(snapshot);
    const entries = await source.listDirectory(snapshot.revision, "topics/api");
    const png = entries.find((entry) => entry.name === "diagram.png");
    expect(png).toMatchObject({ kind: "file", size: expect.any(Number) as number });
    expect(entries.find((entry) => entry.name === "fields.csv")).toMatchObject({ kind: "file" });
    const error = await source.readFile(png as NonNullable<typeof png>).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).kind).toBe("not-found");
  });
});

describe("the hosted demo reads a topic-layout snapshot", () => {
  it("lists the root index with the marker, so topic titles and statuses are available", async () => {
    const snapshot = await topicSnapshot();
    expect(snapshot.files.some((file) => file.path === "index.md")).toBe(true);
    expect(snapshot.files.some((file) => file.path === "README.md")).toBe(false);
    const session = new TopicSession(new DemoSnapshotSource(snapshot));
    await session.open();
    expect(session.inboxLayout).toBe("topic");
    expect(session.topics()).toEqual([
      { name: "api", title: "Recipe API", status: "open", folder: true },
      { name: "general", title: "General", status: "open", folder: true },
      { name: "onboarding", title: "Onboarding", status: "closed", folder: true },
      { name: "recipe-legacy", title: null, status: "legacy", folder: false },
    ]);
  });

  it("opens through openLiveDemo with no API request and merges the legacy inbox", async () => {
    const snapshot = await topicSnapshot();
    const createApiSource = vi.fn();
    const opened = await openLiveDemo(createApiSource, {}, new LiveCheckGate(), presenterEn, () =>
      Promise.resolve(snapshot),
    );
    expect(createApiSource).not.toHaveBeenCalled();
    expect(opened.view.kind).toBe("snapshot");
    const first = messageIds(opened.loader);
    expect(first.length).toBeGreaterThan(0);
    expect(opened.loader.getSnapshot().hasOlder).toBe(true);
    for (let guard = 0; guard < 10 && opened.loader.getSnapshot().hasOlder; guard += 1) {
      await opened.loader.loadOlder();
    }
    const all = messageIds(opened.loader);
    expect(all).toHaveLength(API_IDS.length + 2 + 2);
    expect(all).toContain(LEGACY_API_ID);
    expect(all).toContain(LEGACY_ONLY_ID);
    expect(opened.loader.getSnapshot().participants).toEqual(["alice-agent", "bob-agent"]);
  });

  it("opens one topic, pages back to its legacy message and keeps other topics out", async () => {
    const snapshot = await topicSnapshot();
    const session = new TopicSession(new DemoSnapshotSource(snapshot));
    await session.open();
    const loader = session.loader("api");
    await loader.open();
    const first = messageIds(loader);
    expect(first.length).toBeLessThan(API_IDS.length + 1);
    expect(first).toContain(REFERENCING_ID);
    expect(loader.getSnapshot().hasOlder).toBe(true);
    for (let guard = 0; guard < 10 && loader.getSnapshot().hasOlder; guard += 1)
      await loader.loadOlder();
    const all = messageIds(loader);
    expect(all).toHaveLength(API_IDS.length + 1);
    expect(all).toContain(LEGACY_API_ID);
    expect(all.some((id) => id.includes("-general-") || id.includes("-onboarding-"))).toBe(false);
  });
});

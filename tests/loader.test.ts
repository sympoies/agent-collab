import { describe, expect, it } from "vitest";

import { Loader, SetupError, type TimelineItem } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { flat, MARKER, monthly, repo } from "./support";

function paths(items: readonly TimelineItem[]): string[] {
  return items.map((item) => (item.kind === "message" ? item.message.path : item.path));
}

async function opened(source: FixtureSource, pageSize = 50): Promise<Loader> {
  const loader = new Loader(source, { pageSize });
  await loader.open();
  return loader;
}

describe("Loader.open", () => {
  it("rejects a repository without the collaboration marker", async () => {
    const loader = new Loader(new FixtureSource(repo([], null)));
    await expect(loader.open()).rejects.toThrow(
      new SetupError("not a collaboration repository (no .agent-collab marker)"),
    );
  });

  it("rejects an unsupported protocol version", async () => {
    const loader = new Loader(new FixtureSource(repo([], "collab-protocol: 2\n")));
    await expect(loader.open()).rejects.toThrow(
      new SetupError("unsupported collaboration protocol: collab-protocol: 2"),
    );
  });

  it("opens an empty repository without an inbox", async () => {
    const loader = await opened(new FixtureSource(repo([])));
    expect(loader.getSnapshot()).toMatchObject({ items: [], hasOlder: false });
  });

  it("orders the first page oldest to newest across flat and monthly files", async () => {
    const source = new FixtureSource(
      repo([monthly("2026-10", 2, 1), flat("2026-10", 1, 1), monthly("2026-09", 30, 1)]),
    );
    const loader = await opened(source);
    expect(paths(loader.getSnapshot().items)).toEqual([
      monthly("2026-09", 30, 1),
      flat("2026-10", 1, 1),
      monthly("2026-10", 2, 1),
    ]);
  });

  it("ignores files that are not messages", async () => {
    const files = repo([monthly("2026-10", 1, 1)]);
    files["inbox/.gitkeep"] = "";
    files["inbox/2026-10/.gitkeep"] = "";
    const loader = await opened(new FixtureSource(files));
    expect(paths(loader.getSnapshot().items)).toEqual([monthly("2026-10", 1, 1)]);
  });
});

describe("Loader paging", () => {
  const files = repo([
    monthly("2026-08", 1, 1),
    flat("2026-08", 2, 1),
    monthly("2026-09", 1, 1),
    monthly("2026-09", 2, 1),
    flat("2026-10", 1, 1),
    monthly("2026-10", 2, 1),
  ]);

  it("loads the newest page first and lists only the months it needs", async () => {
    const source = new FixtureSource(files);
    const loader = await opened(source, 2);
    expect(paths(loader.getSnapshot().items)).toEqual([
      flat("2026-10", 1, 1),
      monthly("2026-10", 2, 1),
    ]);
    expect(loader.getSnapshot().hasOlder).toBe(true);
    expect(source.listings).not.toContain("inbox/2026-08");
  });

  it("loads older pages until history is exhausted", async () => {
    const loader = await opened(new FixtureSource(files), 2);
    await loader.loadOlder();
    expect(paths(loader.getSnapshot().items).slice(0, 2)).toEqual([
      monthly("2026-09", 1, 1),
      monthly("2026-09", 2, 1),
    ]);
    await loader.loadOlder();
    expect(paths(loader.getSnapshot().items)).toEqual([
      monthly("2026-08", 1, 1),
      flat("2026-08", 2, 1),
      monthly("2026-09", 1, 1),
      monthly("2026-09", 2, 1),
      flat("2026-10", 1, 1),
      monthly("2026-10", 2, 1),
    ]);
    expect(loader.getSnapshot().hasOlder).toBe(false);
  });

  it("reads each file once across pages", async () => {
    const source = new FixtureSource(files);
    const loader = await opened(source, 2);
    await loader.loadOlder();
    await loader.loadOlder();
    await loader.loadOlder();
    const messageReads = source.reads.filter((path) => path.startsWith("inbox/"));
    expect(new Set(messageReads).size).toBe(messageReads.length);
    expect(messageReads).toHaveLength(6);
  });
});

describe("Loader.refresh", () => {
  it("does no listing or reading when the head is unchanged", async () => {
    const source = new FixtureSource(repo([monthly("2026-10", 1, 1)]));
    const loader = await opened(source);
    const before = { reads: source.reads.length, listings: source.listings.length };
    expect(await loader.refresh()).toBe(0);
    expect({ reads: source.reads.length, listings: source.listings.length }).toEqual(before);
  });

  it("adds a new message in the current month and marks it fresh", async () => {
    const initial = repo([monthly("2026-10", 1, 1)]);
    const source = new FixtureSource(initial);
    const loader = await opened(source);
    source.commit({ ...initial, ...repo([monthly("2026-10", 1, 2)], null) });
    expect(await loader.refresh()).toBe(1);
    const snapshot = loader.getSnapshot();
    expect(paths(snapshot.items)).toEqual([monthly("2026-10", 1, 1), monthly("2026-10", 1, 2)]);
    expect([...snapshot.fresh]).toEqual([monthly("2026-10", 1, 2)]);
  });

  it("picks up a new month folder and a new flat file", async () => {
    const initial = repo([monthly("2026-10", 1, 1)]);
    const source = new FixtureSource(initial);
    const loader = await opened(source);
    source.commit({ ...initial, ...repo([monthly("2026-11", 1, 1), flat("2026-11", 1, 2)], null) });
    expect(await loader.refresh()).toBe(2);
    expect(paths(loader.getSnapshot().items)).toEqual([
      monthly("2026-10", 1, 1),
      monthly("2026-11", 1, 1),
      flat("2026-11", 1, 2),
    ]);
  });

  it("leaves older unlisted months for paging", async () => {
    const initial = repo([monthly("2026-09", 1, 1), monthly("2026-10", 1, 1)]);
    const source = new FixtureSource(initial);
    const loader = await opened(source, 1);
    source.commit({ ...initial, ...repo([monthly("2026-10", 1, 2)], null) });
    expect(await loader.refresh()).toBe(1);
    expect(source.listings).not.toContain("inbox/2026-09");
    await loader.loadOlder();
    expect(paths(loader.getSnapshot().items)).toEqual([
      monthly("2026-09", 1, 1),
      monthly("2026-10", 1, 1),
      monthly("2026-10", 1, 2),
    ]);
  });

  it("notifies subscribers when items change", async () => {
    const initial = repo([monthly("2026-10", 1, 1)]);
    const source = new FixtureSource(initial);
    const loader = await opened(source);
    let calls = 0;
    const unsubscribe = loader.subscribe(() => {
      calls += 1;
    });
    source.commit({ ...initial, ...repo([monthly("2026-10", 1, 2)], null) });
    await loader.refresh();
    unsubscribe();
    expect(calls).toBe(1);
  });
});

describe("Loader tolerance", () => {
  it("keeps malformed files in the timeline", async () => {
    const files = repo([monthly("2026-10", 1, 1)]);
    files["inbox/2026-10/2026-10-01T0902-alice-agent-api-01.md"] = "no front matter";
    const loader = await opened(new FixtureSource(files));
    const items = loader.getSnapshot().items;
    expect(items.map((item) => item.kind)).toEqual(["message", "malformed"]);
  });

  it("shows a file that fails to download as unavailable and keeps the rest", async () => {
    const files = repo([monthly("2026-10", 1, 1), monthly("2026-10", 1, 2)]);
    const source = new FixtureSource(files);
    source.failReads([monthly("2026-10", 1, 1)]);
    const loader = await opened(source);
    expect(loader.getSnapshot().items).toEqual([
      { kind: "unavailable", path: monthly("2026-10", 1, 1), error: "unexpected" },
      expect.objectContaining({ kind: "message" }),
    ]);
  });

  it("parses a marker with Windows line endings", async () => {
    const files = repo([monthly("2026-10", 1, 1)], MARKER.replaceAll("\n", "\r\n"));
    const loader = await opened(new FixtureSource(files));
    expect(loader.getSnapshot().items).toHaveLength(1);
  });
});

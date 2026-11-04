import { describe, expect, it } from "vitest";

import { Loader, SetupError, type TimelineItem } from "../src/loader/loader";
import { deriveQuestionStates } from "../src/message/questions";
import { FixtureSource } from "../src/source/fixture";
import { flat, MARKER, messageText, monthly, repo } from "./support";

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
      new SetupError("not a collaboration repository (no .agent-collab marker)", "no-marker"),
    );
  });

  it("rejects an unsupported protocol version", async () => {
    const loader = new Loader(new FixtureSource(repo([], "collab-protocol: 2\n")));
    await expect(loader.open()).rejects.toThrow(
      new SetupError(
        "unsupported collaboration protocol: collab-protocol: 2",
        "protocol",
        "collab-protocol: 2",
      ),
    );
  });

  it("opens an empty repository without an inbox", async () => {
    const loader = await opened(new FixtureSource(repo([])));
    expect(loader.getSnapshot()).toMatchObject({ items: [], hasOlder: false });
  });

  it("exposes participant metadata from the marker", async () => {
    const marker = `${MARKER}participants: alice-agent,bob-agent,carol-agent\nformer-participants: carol-agent\n`;
    const loader = await opened(new FixtureSource(repo([], marker)));
    expect(loader.getSnapshot()).toMatchObject({
      rosterKnown: true,
      participants: ["alice-agent", "bob-agent", "carol-agent"],
      formerParticipants: ["carol-agent"],
    });
  });

  it("ignores unknown marker keys", async () => {
    const loader = await opened(new FixtureSource(repo([], `${MARKER}language: en\n`)));
    expect(loader.getSnapshot().items).toEqual([]);
    expect(loader.getSnapshot().participants).toEqual([]);
  });

  it("refreshes participant metadata with a changed repository head", async () => {
    const questionId = "2026-10-01T0901-alice-agent-api-01";
    const answerId = "2026-10-01T0902-bob-agent-api-01";
    const questionPath = `inbox/2026-10/${questionId}.md`;
    const answerPath = `inbox/2026-10/${answerId}.md`;
    const question = messageText(questionId, "alice-agent", "api", {
      to: "",
      type: "question",
      replies: "all",
    });
    const initialMarker = `${MARKER}participants: alice-agent,bob-agent\n`;
    const source = new FixtureSource({ ...repo([], initialMarker), [questionPath]: question });
    const loader = await opened(source);

    const formerMarker = `${MARKER}participants: alice-agent,bob-agent\nformer-participants: bob-agent\n`;
    source.commit({
      ...repo([], formerMarker),
      [questionPath]: question,
      [answerPath]: messageText(answerId, "bob-agent", "api", {
        to: "alice-agent",
        type: "answer",
        reply_to: questionId,
      }),
    });
    await loader.refresh();

    const snapshot = loader.getSnapshot();
    expect(snapshot).toMatchObject({
      participants: ["alice-agent", "bob-agent"],
      formerParticipants: ["bob-agent"],
    });
    const messages = snapshot.items.flatMap((item) =>
      item.kind === "message" ? [item.message] : [],
    );
    expect(
      deriveQuestionStates(messages, snapshot.participants, snapshot.formerParticipants)[0],
    ).toMatchObject({
      eligibleAnswerers: [],
      answerers: [],
    });
  });

  it("marks the roster unknown when a changed marker cannot be read", async () => {
    const marker = `${MARKER}participants: alice-agent,bob-agent\n`;
    const source = new FixtureSource(repo([], marker));
    const loader = await opened(source);
    source.commit(repo([], `${marker}former-participants: bob-agent\n`));
    source.failReads([".agent-collab"]);

    await expect(loader.refresh()).rejects.toMatchObject({ kind: "unexpected" });
    expect(loader.getSnapshot()).toMatchObject({ rosterKnown: false, participants: [] });
  });

  it("reuses parsed marker data when its blob id is unchanged", async () => {
    const marker = `${MARKER}participants: alice-agent,bob-agent\n`;
    const initial = repo([monthly("2026-10", 1, 1)], marker);
    const source = new FixtureSource(initial);
    const loader = await opened(source);
    expect(source.reads.filter((path) => path === ".agent-collab")).toHaveLength(1);

    source.commit({ ...initial, [monthly("2026-10", 1, 2)]: "new revision" });
    await loader.refresh();
    expect(source.reads.filter((path) => path === ".agent-collab")).toHaveLength(1);
  });

  it("reports topics with listed but not yet loaded message files", async () => {
    const questionId = "2026-10-01T0902-alice-agent-api-01";
    const answerId = "2026-10-01T0901-bob-agent-api-01";
    const files = {
      ...repo([], `${MARKER}participants: alice-agent,bob-agent\n`),
      [`inbox/2026-10/${questionId}.md`]: messageText(questionId, "alice-agent", "api", {
        to: "",
        type: "question",
      }),
      [`inbox/2026-10/${answerId}.md`]: messageText(answerId, "bob-agent", "api", {
        to: "alice-agent",
        type: "answer",
        reply_to: questionId,
      }),
    };
    const loader = new Loader(new FixtureSource(files), { pageSize: 1 });
    await loader.open();
    const snapshot = loader.getSnapshot();
    expect(snapshot.incompleteTopics).toEqual(["api"]);
    const messages = snapshot.items.flatMap((item) =>
      item.kind === "message" ? [item.message] : [],
    );
    expect(
      deriveQuestionStates(messages, snapshot.participants, snapshot.formerParticipants, {
        rosterKnown: snapshot.rosterKnown,
        incompleteTopics: snapshot.incompleteTopics,
      })[0],
    ).toMatchObject({ state: "unknown", progress: null });
  });

  it("marks a question topic incomplete when one of its files is unavailable", async () => {
    const questionId = "2026-10-01T0901-alice-agent-api-01";
    const answerId = "2026-10-01T0902-bob-agent-api-01";
    const questionPath = `inbox/2026-10/${questionId}.md`;
    const answerPath = `inbox/2026-10/${answerId}.md`;
    const source = new FixtureSource({
      ...repo([], `${MARKER}participants: alice-agent,bob-agent\n`),
      [questionPath]: messageText(questionId, "alice-agent", "api", {
        to: "",
        type: "question",
      }),
      [answerPath]: messageText(answerId, "bob-agent", "api", {
        to: "alice-agent",
        type: "answer",
        reply_to: questionId,
      }),
    });
    source.failReads([answerPath]);
    const loader = await opened(source);
    const snapshot = loader.getSnapshot();
    expect(snapshot.incompleteTopics).toEqual(["api"]);
    const messages = snapshot.items.flatMap((item) =>
      item.kind === "message" ? [item.message] : [],
    );
    expect(
      deriveQuestionStates(messages, snapshot.participants, snapshot.formerParticipants, {
        rosterKnown: snapshot.rosterKnown,
        incompleteTopics: snapshot.incompleteTopics,
      })[0],
    ).toMatchObject({ state: "unknown", progress: null });
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

describe("Loader.jumpTo", () => {
  const files = repo([
    monthly("2026-07", 3, 1),
    monthly("2026-08", 10, 1),
    monthly("2026-08", 15, 1),
    monthly("2026-08", 15, 2),
    monthly("2026-08", 20, 1),
    monthly("2026-09", 1, 1),
    flat("2026-10", 1, 1),
    monthly("2026-10", 2, 1),
  ]);

  it("lists one month folder and reads one page, never the messages in between", async () => {
    const source = new FixtureSource(files);
    const loader = await opened(source, 2);
    source.listings.length = 0;
    source.reads.length = 0;
    await loader.jumpTo("2026-08-15");
    expect(source.listings).toEqual(["inbox/2026-08"]);
    expect(source.reads).toEqual([monthly("2026-08", 15, 2), monthly("2026-08", 15, 1)]);
    expect(paths(loader.getSnapshot().items)).toEqual([
      monthly("2026-08", 15, 1),
      monthly("2026-08", 15, 2),
    ]);
    expect(loader.getSnapshot()).toMatchObject({ hasOlder: true, hasNewer: true });
  });

  it("pages older from the chosen day with the usual Load older", async () => {
    const loader = await opened(new FixtureSource(files), 2);
    await loader.jumpTo("2026-08-15");
    await loader.loadOlder();
    expect(paths(loader.getSnapshot().items)).toEqual([
      monthly("2026-07", 3, 1),
      monthly("2026-08", 10, 1),
      monthly("2026-08", 15, 1),
      monthly("2026-08", 15, 2),
    ]);
    expect(loader.getSnapshot().hasOlder).toBe(false);
  });

  it("takes files directly in inbox into account and lists only the month folder of the day", async () => {
    const source = new FixtureSource(files);
    const loader = await opened(source, 1);
    source.listings.length = 0;
    await loader.jumpTo("2026-10-01");
    expect(paths(loader.getSnapshot().items)).toEqual([flat("2026-10", 1, 1)]);
    expect(source.listings).toEqual(["inbox/2026-10"]);
  });

  it("is not a jump when nothing is newer than the chosen day", async () => {
    const loader = await opened(new FixtureSource(files), 2);
    await loader.jumpTo("2026-12-31");
    expect(loader.getSnapshot().hasNewer).toBe(false);
    expect(paths(loader.getSnapshot().items)).toEqual([
      flat("2026-10", 1, 1),
      monthly("2026-10", 2, 1),
    ]);
  });

  it("keeps newer arrivals out of the range on refresh and returns to the newest page with null", async () => {
    const source = new FixtureSource(files);
    const loader = await opened(source, 2);
    await loader.jumpTo("2026-08-15");
    source.commit({
      ...files,
      [monthly("2026-10", 3, 1)]: files[monthly("2026-10", 2, 1)] as string,
    });
    expect(await loader.refresh()).toBe(0);
    expect(paths(loader.getSnapshot().items)).toEqual([
      monthly("2026-08", 15, 1),
      monthly("2026-08", 15, 2),
    ]);
    await loader.jumpTo(null);
    expect(loader.getSnapshot().hasNewer).toBe(false);
    expect(paths(loader.getSnapshot().items)).toEqual([
      monthly("2026-10", 2, 1),
      monthly("2026-10", 3, 1),
    ]);
  });

  it("reports question topics as unknown while newer messages are not loaded", async () => {
    const loader = await opened(new FixtureSource(files), 50);
    expect(loader.getSnapshot().incompleteTopics).toEqual([]);
    await loader.jumpTo("2026-08-15");
    expect(loader.getSnapshot().incompleteTopics).toBeNull();
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

  it("replaces a loaded message whose file was edited, without marking it new", async () => {
    const path = monthly("2026-10", 1, 1);
    const id = path.slice(path.lastIndexOf("/") + 1, -".md".length);
    const initial = repo([path]);
    const source = new FixtureSource(initial);
    const loader = await opened(source);
    expect(loader.getSnapshot().items[0]).toMatchObject({
      message: { body: { lines: [`Message ${id}.`] } },
    });
    source.commit({
      ...initial,
      [path]: messageText(id, "alice-agent", "api", {}, "Edited in place."),
    });
    expect(await loader.refresh()).toBe(0);
    const snapshot = loader.getSnapshot();
    expect(paths(snapshot.items)).toEqual([path]);
    expect(snapshot.items[0]).toMatchObject({ message: { body: { lines: ["Edited in place."] } } });
    expect(snapshot.fresh.size).toBe(0);
  });

  it("uses the changed entry when an edited message is still waiting on an older page", async () => {
    const oldest = monthly("2026-09", 1, 1);
    const newest = monthly("2026-10", 1, 1);
    const oldestId = oldest.slice(oldest.lastIndexOf("/") + 1, -".md".length);
    const initial = repo([oldest, newest]);
    const source = new FixtureSource(initial);
    const loader = await opened(source, 1);
    expect(paths(loader.getSnapshot().items)).toEqual([newest]);
    source.commit({
      ...initial,
      [oldest]: messageText(oldestId, "alice-agent", "api", {}, "Edited before it was loaded."),
    });
    await loader.refresh();
    await loader.loadOlder();
    const first = loader.getSnapshot().items[0];
    expect(first).toMatchObject({ message: { body: { lines: ["Edited before it was loaded."] } } });
  });

  it("exposes when the data last changed, if the source knows", async () => {
    const source = new FixtureSource(repo([monthly("2026-10", 1, 1)]));
    const when = new Date("2026-11-03T08:00:00Z");
    Object.assign(source, { lastChanged: () => when });
    const loader = await opened(source);
    expect(loader.getSnapshot().lastChanged).toEqual(when);
    expect((await opened(new FixtureSource(repo([])))).getSnapshot().lastChanged).toBeNull();
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

describe("Loader recovery", () => {
  it("retries open after a failure", async () => {
    const source = new FixtureSource(repo([monthly("2026-10", 1, 1)]));
    source.failListings(["inbox"]);
    const loader = new Loader(source);
    await expect(loader.open()).rejects.toMatchObject({ kind: "unreachable" });
    source.failListings([]);
    await loader.open();
    expect(paths(loader.getSnapshot().items)).toEqual([monthly("2026-10", 1, 1)]);
  });

  it("opens instead of refreshing when open has not succeeded", async () => {
    const source = new FixtureSource(repo([monthly("2026-10", 1, 1)], "collab-protocol: 2\n"));
    const loader = new Loader(source);
    await expect(loader.open()).rejects.toBeInstanceOf(SetupError);
    await expect(loader.refresh()).rejects.toBeInstanceOf(SetupError);
    expect(loader.getSnapshot().items).toEqual([]);
  });

  it("keeps entries taken for a page when listing an older month fails", async () => {
    const source = new FixtureSource(
      repo([
        monthly("2026-08", 1, 1),
        flat("2026-09", 1, 1),
        monthly("2026-10", 1, 1),
        monthly("2026-10", 2, 1),
      ]),
    );
    const loader = await opened(source, 2);
    source.failListings(["inbox/2026-08"]);
    await expect(loader.loadOlder()).rejects.toMatchObject({ kind: "unreachable" });
    source.failListings([]);
    await loader.loadOlder();
    expect(paths(loader.getSnapshot().items)).toEqual([
      monthly("2026-08", 1, 1),
      flat("2026-09", 1, 1),
      monthly("2026-10", 1, 1),
      monthly("2026-10", 2, 1),
    ]);
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

  it("downloads a file again on refresh after it was unavailable", async () => {
    const files = repo([monthly("2026-10", 1, 1), monthly("2026-10", 1, 2)]);
    const source = new FixtureSource(files);
    source.failReads([monthly("2026-10", 1, 1)]);
    const loader = await opened(source);
    source.failReads([]);
    expect(await loader.refresh()).toBe(0);
    expect(loader.getSnapshot().items.map((item) => item.kind)).toEqual(["message", "message"]);
  });

  it("retries a file that keeps failing with growing spacing", async () => {
    const failing = monthly("2026-10", 1, 1);
    const source = new FixtureSource(repo([failing, monthly("2026-10", 1, 2)]));
    source.failReads([failing]);
    const loader = await opened(source);
    const readsAfter: number[] = [];
    for (let poll = 1; poll <= 10; poll += 1) {
      expect(await loader.refresh()).toBe(0);
      readsAfter.push(source.reads.filter((path) => path === failing).length);
    }
    // Read at open, then on polls 1, 3 and 7 (spacing 1, 2, 4, ...).
    expect(readsAfter).toEqual([2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
    expect(loader.getSnapshot().fresh.size).toBe(0);
  });

  it("does not count or mark a new file that fails to download", async () => {
    const initial = repo([monthly("2026-10", 1, 1)]);
    const source = new FixtureSource(initial);
    const loader = await opened(source);
    source.commit({ ...initial, ...repo([monthly("2026-10", 1, 2)], null) });
    source.failReads([monthly("2026-10", 1, 2)]);
    expect(await loader.refresh()).toBe(0);
    expect(loader.getSnapshot().fresh.size).toBe(0);
    expect(loader.getSnapshot().items.map((item) => item.kind)).toEqual(["message", "unavailable"]);
  });

  it("parses a marker with a leading byte order mark", async () => {
    const files = repo([monthly("2026-10", 1, 1)], `\uFEFF${MARKER}`);
    const loader = await opened(new FixtureSource(files));
    expect(loader.getSnapshot().items).toHaveLength(1);
  });

  it("parses a marker with Windows line endings", async () => {
    const files = repo([monthly("2026-10", 1, 1)], MARKER.replaceAll("\n", "\r\n"));
    const loader = await opened(new FixtureSource(files));
    expect(loader.getSnapshot().items).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from "vitest";

import { Secret } from "../src/credentials/secret";
import { Loader, SetupError } from "../src/loader/loader";
import { readTopicList, topicLoader } from "../src/loader/topic-reader";
import {
  isKnownLayout,
  isTopicFolderName,
  MAX_INDEX_BYTES,
  markerLayout,
  parseRootIndex,
  parseTopicFile,
  topicMessagePath,
} from "../src/message/topic-layout";
import { FixtureSource } from "../src/source/fixture";
import { GitHubSource } from "../src/source/github";
import { messageText } from "./support";

const MARKER = "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n";

/** A message id: day d of November 2026, minute m, from alice-agent on `topic`. */
function id(day: number, minute: number, topic: string, from = "alice-agent"): string {
  return `2026-11-${String(day).padStart(2, "0")}T09${String(minute).padStart(2, "0")}-${from}-${topic}-01`;
}

function inTopic(topic: string, day: number, minute: number): [string, string] {
  const mid = id(day, minute, topic);
  return [
    `topics/${topic}/inbox/${mid.slice(0, 7)}/${mid}.md`,
    messageText(mid, "alice-agent", topic),
  ];
}

function legacy(topic: string, day: number, minute: number, month = false): [string, string] {
  const mid = id(day, minute, topic);
  const path = month ? `inbox/${mid.slice(0, 7)}/${mid}.md` : `inbox/${mid}.md`;
  return [path, messageText(mid, "alice-agent", topic)];
}

function repoOf(entries: readonly [string, string][], marker = MARKER): Record<string, string> {
  return { ".agent-collab": marker, ...Object.fromEntries(entries) };
}

const names = (loader: Loader) =>
  loader.getSnapshot().items.map((item) => (item.kind === "message" ? item.message.id : item.path));

describe("topic layout grammar", () => {
  it.each([
    ["api", true],
    ["api-v2", true],
    ["a1-b2-c3", true],
    ["a--b", false],
    ["-x", false],
    ["x-", false],
    ["Api", false],
    ["a_b", false],
    ["", false],
    ["inbox", false],
    ["index", false],
    ["open", false],
    ["general", true],
  ])("topic folder name %j is %s", (name, valid) => {
    expect(isTopicFolderName(name)).toBe(valid);
  });

  it("reads the layout from the marker, flat when absent", () => {
    expect(markerLayout("collab-protocol: 1\n")).toBe("flat");
    expect(markerLayout("collab-protocol: 1\ninbox-layout: monthly\n")).toBe("monthly");
    expect(markerLayout("collab-protocol: 1\r\nlanguage: en\r\ninbox-layout:  topic \r\n")).toBe(
      "topic",
    );
    expect(isKnownLayout("topic")).toBe(true);
    expect(isKnownLayout("flat")).toBe(true);
    expect(isKnownLayout("weekly")).toBe(false);
  });

  it("splits a topic message path and rejects every other", () => {
    expect(topicMessagePath("topics/api/inbox/2026-11/x.md")).toEqual({
      topic: "api",
      month: "2026-11",
    });
    for (const other of [
      "inbox/2026-11/x.md",
      "topics/api/x.md",
      "topics/api/inbox/x.md",
      "topics/api/inbox/2026-11/deeper/x.md",
      "topics/api/inbox/2026-1/x.md",
    ]) {
      expect(topicMessagePath(other), other).toBeNull();
    }
  });
});

describe("the root topic index", () => {
  const table = (rows: string[], header = "| topic | title | status |") =>
    [header, "|---|---|---|", ...rows].join("\n");

  it("reads names, titles and statuses, English or Chinese headers", () => {
    expect(
      parseRootIndex(
        table(["| api | The API | open |", "| old | Old work | closed |", "| a--b |  | legacy |"]),
      ),
    ).toEqual([
      { name: "api", title: "The API", status: "open" },
      { name: "old", title: "Old work", status: "closed" },
      { name: "a--b", title: null, status: "legacy" },
    ]);
    expect(parseRootIndex(table(["| api | 介面 | closed |"], "| 主題 | 標題 | 狀態 |"))).toEqual([
      { name: "api", title: "介面", status: "closed" },
    ]);
  });

  it("treats every cell as plain text and ignores bad rows", () => {
    const rows = parseRootIndex(
      table([
        "| [api](topics/api/) | <b>x</b>\u0007bell | open |",
        "| Not A Name | t | open |",
        "|  |  |  |",
        "| ok | t | something-else |",
        "not a row",
      ]),
    );
    expect(rows).toEqual([
      { name: "api", title: "<b>x</b>bell", status: "open" },
      { name: "ok", title: "t", status: "open" },
    ]);
  });

  it("caps the title, the rows and the size, and needs a header", () => {
    expect(parseRootIndex(table([`| api | ${"x".repeat(500)} | open |`]))[0]?.title).toHaveLength(
      80,
    );
    const many = Array.from({ length: 6000 }, (_, i) => `| t${String(i)} | | open |`);
    expect(parseRootIndex(table(many))).toHaveLength(5000);
    expect(
      parseRootIndex(`${table(["| api | | open |"])}\n${"x".repeat(MAX_INDEX_BYTES)}`),
    ).toEqual([]);
    expect(parseRootIndex("| api | | open |\n| b | | open |")).toEqual([]);
    expect(parseRootIndex("")).toEqual([]);
  });
});

describe("TOPIC.md", () => {
  it("reads the optional front matter and ignores the body", () => {
    expect(
      parseTopicFile(
        "---\ntitle: Release\ndescription: The next release.\nstatus: closed\nclosed-digest: " +
          "a".repeat(64) +
          "\n---\nfree text: not parsed\n",
      ),
    ).toEqual({
      title: "Release",
      description: "The next release.",
      status: "closed",
      closedDigest: "a".repeat(64),
    });
  });

  it("is open and untitled without front matter, and ignores a bad digest or status", () => {
    expect(parseTopicFile("just text")).toEqual({
      title: null,
      description: null,
      status: "open",
      closedDigest: null,
    });
    expect(parseTopicFile("---\nstatus: archived\nclosed-digest: nope\n---\n")).toMatchObject({
      status: "open",
      closedDigest: null,
    });
    expect(parseTopicFile("---\ntitle: " + "t".repeat(300) + "\n---\n").title).toHaveLength(80);
  });
});

describe("the topic list", () => {
  const topicsRepo = (index: string | null) =>
    repoOf([
      ...["api", "ops", "release"].map((t) => inTopic(t, 3, 1)),
      ["topics/api/notes.md", "# attachment"],
      ["topics/a--b/inbox/2026-11/x.md", "not a topic folder"],
      ...(index === null ? [] : ([["index.md", index]] as [string, string][])),
    ]);

  it("lists topic folders with titles and statuses from the root index, then legacy-only topics", async () => {
    const index = [
      "| topic | title | status |",
      "|---|---|---|",
      "| api | The API | open |",
      "| ops | Operations | closed |",
      "| ghost | No folder | open |",
      "| a--b | Old name | legacy |",
      "| release | | legacy |",
    ].join("\n");
    const list = await readTopicList(new FixtureSource(topicsRepo(index)));
    expect(list.layout).toBe("topic");
    expect(list.topics).toEqual([
      { name: "api", title: "The API", status: "open", folder: true },
      { name: "ops", title: "Operations", status: "closed", folder: true },
      // A stale legacy row cannot demote a topic that has a folder.
      { name: "release", title: null, status: "open", folder: true },
      { name: "a--b", title: "Old name", status: "legacy", folder: false },
    ]);
  });

  it("works without an index, with an unreadable one and with an oversized one", async () => {
    const plain = await readTopicList(new FixtureSource(topicsRepo(null)));
    expect(plain.topics.map((t) => [t.name, t.title, t.status])).toEqual([
      ["api", null, "open"],
      ["ops", null, "open"],
      ["release", null, "open"],
    ]);
    const source = new FixtureSource(topicsRepo("| topic |\n|---|\n| api |"));
    vi.spyOn(source, "readFile").mockImplementation((entry) =>
      entry.path === "index.md"
        ? Promise.reject(new Error("unreadable"))
        : Promise.resolve("collab-protocol: 1\ninbox-layout: topic\n"),
    );
    expect((await readTopicList(source)).topics).toHaveLength(3);
    const huge = new FixtureSource(
      topicsRepo(`| topic | title |\n|---|---|\n| api | ${"x".repeat(MAX_INDEX_BYTES)} |`),
    );
    const read = vi.spyOn(huge, "readFile");
    expect((await readTopicList(huge)).topics.every((t) => t.title === null)).toBe(true);
    expect(read.mock.calls.map(([entry]) => entry.path)).not.toContain("index.md");
  });

  it("has no topics for the other layouts and no topics directory", async () => {
    expect(
      (await readTopicList(new FixtureSource({ ".agent-collab": "collab-protocol: 1\n" }))).topics,
    ).toEqual([]);
    expect(
      (
        await readTopicList(
          new FixtureSource({ ".agent-collab": "collab-protocol: 1\ninbox-layout: monthly\n" }),
        )
      ).layout,
    ).toBe("monthly");
    expect((await readTopicList(new FixtureSource(repoOf([])))).topics).toEqual([]);
  });

  it("refuses a missing marker, another protocol and an unknown layout", async () => {
    await expect(readTopicList(new FixtureSource({}))).rejects.toMatchObject({ code: "no-marker" });
    await expect(
      readTopicList(new FixtureSource({ ".agent-collab": "collab-protocol: 2\n" })),
    ).rejects.toMatchObject({ code: "protocol" });
    await expect(
      readTopicList(
        new FixtureSource({ ".agent-collab": "collab-protocol: 1\ninbox-layout: weekly\n" }),
      ),
    ).rejects.toMatchObject({ code: "layout", detail: "weekly" });
  });
});

describe("loading a topic-layout repository", () => {
  const files = () =>
    repoOf([
      inTopic("api", 3, 1),
      inTopic("api", 5, 2),
      inTopic("ops", 4, 3),
      inTopic("release", 6, 4),
      // Legacy messages, flat and monthly, remain valid and belong to their own topics.
      legacy("api", 1, 5),
      legacy("ops", 2, 6, true),
      ["topics/api/spec.md", "# an attachment next to the inbox folder"],
    ]);

  it("merges every topic and the legacy inbox into one newest-first timeline with real paths", async () => {
    const loader = new Loader(new FixtureSource(files()));
    await loader.open();
    const items = loader.getSnapshot().items;
    expect(items.map((item) => (item.kind === "message" ? item.message.id : ""))).toEqual([
      id(1, 5, "api"),
      id(2, 6, "ops"),
      id(3, 1, "api"),
      id(4, 3, "ops"),
      id(5, 2, "api"),
      id(6, 4, "release"),
    ]);
    const paths = items.map((item) => (item.kind === "message" ? item.message.path : ""));
    expect(paths).toContain(`topics/ops/inbox/2026-11/${id(4, 3, "ops")}.md`);
    expect(paths).toContain(`inbox/${id(1, 5, "api")}.md`);
    expect(paths).toContain(`inbox/2026-11/${id(2, 6, "ops")}.md`);
    expect(items.every((item) => item.kind === "message" && item.message.issues.length === 0)).toBe(
      true,
    );
    expect(loader.getSnapshot().hasOlder).toBe(false);
  });

  it("pages newest first across topics and reads only the page", async () => {
    const entries: [string, string][] = [];
    for (let day = 1; day <= 20; day += 1) {
      for (const [index, topic] of ["api", "ops", "release"].entries()) {
        entries.push(inTopic(topic, day, index + 1));
      }
    }
    const source = new FixtureSource(repoOf(entries));
    const loader = new Loader(source, { pageSize: 10 });
    await loader.open();
    const first = names(loader);
    expect(first).toHaveLength(10);
    expect(first.at(-1)).toBe(id(20, 3, "release"));
    expect(first[0]).toBe(id(17, 3, "release"));
    expect(source.reads.filter((path) => path.includes("/inbox/"))).toHaveLength(10);
    expect(loader.getSnapshot().hasOlder).toBe(true);
    await loader.loadOlder();
    expect(names(loader)).toHaveLength(20);
    expect(source.reads.filter((path) => path.includes("/inbox/"))).toHaveLength(20);
    while (loader.getSnapshot().hasOlder) await loader.loadOlder();
    expect(names(loader)).toHaveLength(60);
    expect(loader.getSnapshot().hasOlder).toBe(false);
  });

  it("shows a message that arrives in a topic folder after a refresh, as fresh", async () => {
    const source = new FixtureSource(files());
    const loader = new Loader(source);
    await loader.open();
    source.commit({ ...files(), ...Object.fromEntries([inTopic("ops", 7, 9)]) });
    expect(await loader.refresh()).toBe(1);
    expect(names(loader).at(-1)).toBe(id(7, 9, "ops"));
    expect([...loader.getSnapshot().fresh]).toEqual([
      `topics/ops/inbox/2026-11/${id(7, 9, "ops")}.md`,
    ]);
    // A new topic, and a refresh with nothing new.
    source.commit({
      ...files(),
      ...Object.fromEntries([inTopic("ops", 7, 9), inTopic("newtopic", 8, 1)]),
    });
    expect(await loader.refresh()).toBe(1);
    expect(await loader.refresh()).toBe(0);
  });

  it("flags a message whose folder names another topic", async () => {
    const mid = id(3, 1, "api");
    const loader = new Loader(
      new FixtureSource(
        repoOf([[`topics/ops/inbox/2026-11/${mid}.md`, messageText(mid, "alice-agent", "api")]]),
      ),
    );
    await loader.open();
    const item = loader.getSnapshot().items[0];
    expect(item?.kind === "message" ? item.message.issues : []).toContain(
      "topic folder ops does not match topic=api",
    );
  });

  it("flags a month folder that differs from the id month", async () => {
    const mid = id(3, 1, "api");
    const loader = new Loader(
      new FixtureSource(
        repoOf([[`topics/api/inbox/2026-10/${mid}.md`, messageText(mid, "alice-agent", "api")]]),
      ),
    );
    await loader.open();
    const item = loader.getSnapshot().items[0];
    expect(item?.kind === "message" ? item.message.issues : []).toContain(
      "month folder 2026-10 does not match id month 2026-11",
    );
  });

  it("ignores folders that are not topic folders and files that are not messages", async () => {
    const source = new FixtureSource(
      repoOf([
        inTopic("api", 3, 1),
        ["topics/a--b/inbox/2026-11/x.md", "ignored"],
        ["topics/inbox/inbox/2026-11/x.md", "ignored"],
        ["topics/api/inbox/notes.txt", "a stray file"],
        ["topics/api/inbox/2026-11/readme.txt", "not a message"],
      ]),
    );
    const loader = new Loader(source);
    await loader.open();
    expect(names(loader)).toEqual([id(3, 1, "api")]);
    expect(source.reads).not.toContain("topics/a--b/inbox/2026-11/x.md");
  });

  it("opens an empty topic repository and one with only legacy messages", async () => {
    const empty = new Loader(new FixtureSource(repoOf([])));
    await empty.open();
    expect(empty.getSnapshot().items).toEqual([]);
    const onlyLegacy = new Loader(new FixtureSource(repoOf([legacy("api", 1, 1)])));
    await onlyLegacy.open();
    expect(names(onlyLegacy)).toEqual([id(1, 1, "api")]);
  });

  it("refuses an unknown layout with its own setup error", async () => {
    const loader = new Loader(
      new FixtureSource({ ".agent-collab": "collab-protocol: 1\ninbox-layout: weekly\n" }),
    );
    await expect(loader.open()).rejects.toBeInstanceOf(SetupError);
    await expect(loader.open()).rejects.toMatchObject({ code: "layout", detail: "weekly" });
  });

  it("leaves flat and monthly repositories alone, even with a topics folder of attachments", async () => {
    for (const marker of ["collab-protocol: 1\n", "collab-protocol: 1\ninbox-layout: monthly\n"]) {
      const mid = id(3, 1, "api");
      const source = new FixtureSource({
        ".agent-collab": marker,
        [`inbox/${mid}.md`]: messageText(mid, "alice-agent", "api"),
        // Looks like a topic message but the marker does not say topic: never read as one.
        [`topics/api/inbox/2026-11/${id(4, 1, "api")}.md`]: messageText(
          id(4, 1, "api"),
          "alice-agent",
          "api",
        ),
      });
      const loader = new Loader(source);
      await loader.open();
      expect(names(loader)).toEqual([mid]);
      expect(source.listings).toContain("inbox");
      expect(source.listings).not.toContain("topics");
    }
  });
});

describe("loading one topic", () => {
  it("reads only that topic's folder and the legacy messages that name it", async () => {
    const source = new FixtureSource(
      repoOf([
        inTopic("api", 3, 1),
        inTopic("api", 5, 2),
        inTopic("ops", 4, 3),
        legacy("api", 1, 5),
        legacy("ops", 2, 6),
        legacy("api", 2, 7, true),
      ]),
    );
    const loader = topicLoader(source, "api");
    await loader.open();
    expect(names(loader)).toEqual([
      id(1, 5, "api"),
      id(2, 7, "api"),
      id(3, 1, "api"),
      id(5, 2, "api"),
    ]);
    expect(source.reads.some((path) => path.includes("ops"))).toBe(false);
    expect(source.listings).not.toContain("topics/ops/inbox");
  });

  it("pages that topic alone and finds new messages for it only", async () => {
    const entries: [string, string][] = [];
    for (let day = 1; day <= 12; day += 1) {
      entries.push(inTopic("api", day, 1), inTopic("ops", day, 2));
    }
    const source = new FixtureSource(repoOf(entries));
    const loader = topicLoader(source, "api", { pageSize: 5 });
    await loader.open();
    expect(names(loader)).toHaveLength(5);
    expect(source.reads.filter((path) => path.includes("/inbox/"))).toHaveLength(5);
    expect(loader.getSnapshot().hasOlder).toBe(true);
    source.commit({
      ...repoOf(entries),
      ...Object.fromEntries([inTopic("ops", 13, 3), inTopic("api", 13, 4)]),
    });
    expect(await loader.refresh()).toBe(1);
    expect(names(loader).at(-1)).toBe(id(13, 4, "api"));
  });

  it("shows nothing for a name that is not a topic folder", async () => {
    const loader = topicLoader(new FixtureSource(repoOf([inTopic("api", 3, 1)])), "a--b");
    await loader.open();
    expect(loader.getSnapshot().items).toEqual([]);
  });
});

describe("a large repository", () => {
  it("opens a 5,000-message topic repository by reading one page, and pages on demand", async () => {
    const topics = Array.from({ length: 12 }, (_, i) => `topic-${String(i)}`);
    const entries: [string, string][] = [];
    for (let n = 0; n < 5000; n += 1) {
      const topic = topics[n % 12] as string;
      const month = 1 + Math.floor(n / 250);
      const mid = `2026-${String(month).padStart(2, "0")}-${String(1 + (n % 28)).padStart(2, "0")}T${String(Math.floor(n / 60) % 24).padStart(2, "0")}${String(n % 60).padStart(2, "0")}-alice-agent-${topic}-01`;
      entries.push([
        `topics/${topic}/inbox/${mid.slice(0, 7)}/${mid}.md`,
        messageText(mid, "alice-agent", topic),
      ]);
    }
    const source = new FixtureSource(repoOf(entries));
    const loader = new Loader(source);
    await loader.open();
    const reads = () => source.reads.filter((path) => path.includes("/inbox/")).length;
    expect(loader.getSnapshot().items).toHaveLength(50);
    expect(reads()).toBe(50);
    expect(loader.getSnapshot().hasOlder).toBe(true);
    await loader.loadOlder();
    expect(reads()).toBe(100);
    expect(names(loader)).toEqual([...names(loader)].sort());
  });
});

describe("requests before any message", () => {
  const API = "https://api.example.test";
  const REPO = `${API}/repos/alice-org/collab`;

  function stub(topics: number, branch: string | null) {
    const calls: string[] = [];
    const names = Array.from({ length: topics }, (_, i) => `topic-${String(i)}`);
    const rows = names.map((name) => `| ${name} | Title of ${name} | open |`).join("\n");
    const bodies: Record<string, string> = {
      marker: MARKER,
      index: `| topic | title | status |\n|---|---|---|\n${rows}\n`,
    };
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const entry = (path: string, type: "blob" | "tree", sha: string) => ({
      path,
      type,
      sha,
      mode: type === "tree" ? "040000" : "100644",
      size: 100,
    });
    const fetch = (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push(url.slice(API.length));
      const route = url.slice(REPO.length);
      if (route === "") return Promise.resolve(json({ default_branch: "main" }));
      if (route.startsWith("/git/ref/heads/"))
        return Promise.resolve(json({ object: { sha: "c1" } }));
      if (route === "/git/commits/c1") return Promise.resolve(json({ tree: { sha: "root" } }));
      if (route === "/git/trees/root") {
        return Promise.resolve(
          json({
            truncated: false,
            tree: [
              entry(".agent-collab", "blob", "marker"),
              entry("index.md", "blob", "index"),
              entry("topics", "tree", "topics"),
            ],
          }),
        );
      }
      if (route === "/git/trees/topics") {
        return Promise.resolve(
          json({
            truncated: false,
            tree: names.map((name) => entry(name, "tree", `tree-${name}`)),
          }),
        );
      }
      const blob = /^\/git\/blobs\/(.+)$/.exec(route)?.[1];
      if (blob !== undefined && bodies[blob] !== undefined) {
        return Promise.resolve(new Response(bodies[blob]));
      }
      throw new Error(`unexpected request: ${route}`);
    };
    const source = new GitHubSource({
      apiBase: API,
      owner: "alice-org",
      repo: "collab",
      branch,
      token: new Secret("test-token-not-real"),
      fetch,
    });
    return { source, calls };
  }

  it("costs about six API requests for 12 topics, and none for a message", async () => {
    const { source, calls } = stub(12, "main");
    const list = await readTopicList(source);
    expect(list.topics).toHaveLength(12);
    expect(list.topics.find((topic) => topic.name === "topic-3")).toMatchObject({
      title: "Title of topic-3",
      status: "open",
    });
    expect(calls).toEqual([
      "/repos/alice-org/collab/git/ref/heads/main",
      "/repos/alice-org/collab/git/commits/c1",
      "/repos/alice-org/collab/git/trees/root",
      "/repos/alice-org/collab/git/blobs/marker",
      "/repos/alice-org/collab/git/trees/topics",
      "/repos/alice-org/collab/git/blobs/index",
    ]);
  });

  it("is the same six requests (seven with the default-branch lookup) for 3 or 300 topics", async () => {
    const small = stub(3, null);
    await readTopicList(small.source);
    const large = stub(300, null);
    expect((await readTopicList(large.source)).topics).toHaveLength(300);
    expect(small.calls).toHaveLength(7);
    expect(large.calls).toHaveLength(7);
  });
});

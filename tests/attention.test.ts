import { describe, expect, it } from "vitest";

import { Secret } from "../src/credentials/secret";
import { EMPTY_TOPIC_PREFERENCES, toggleTopic } from "../src/identity/topic-preferences";
import { ATTENTION_TOPIC_LIMIT, loadAttention } from "../src/loader/attention";
import { TopicSession } from "../src/loader/topic-session";
import { FixtureSource } from "../src/source/fixture";
import { GitHubSource } from "../src/source/github";
import { API, git, REPO } from "./git-stub";
import { messageText } from "./support";

const MARKER = "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n";
const id = (topic: string, day: number, from = "alice-agent") =>
  `2026-11-${String(day).padStart(2, "0")}T0900-${from}-${topic}-01`;
const messagePath = (topic: string, day: number, from = "alice-agent") =>
  `topics/${topic}/inbox/2026-11/${id(topic, day, from)}.md`;

/** open.md in the tool's layout: one section per kind of item, rows of id, from, to, needs. */
function openFile(topic: string, rows: [number, string][]): string {
  return [
    "<!-- generated -->",
    "# Open items",
    "",
    "## Unanswered questions",
    "",
    "| id | from | to | needs | due | 摘要 |",
    "|---|---|---|---|---|---|",
    ...rows.map(([day, to]) => `| ${id(topic, day)} | alice-agent | ${to} | answer | | s |`),
    "",
  ].join("\n");
}

function indexFile(topic: string, days: number[]): string {
  return [
    "| id | from | to | type | topic | reply_to | needs | 摘要 |",
    "|---|---|---|---|---|---|---|---|",
    ...days.map(
      (d) => `| ${id(topic, d)} | alice-agent | bob-agent | question | ${topic} |  | answer | s |`,
    ),
  ].join("\n");
}

interface Spec {
  readonly name: string;
  readonly status?: "open" | "closed";
  /** Message days; the newest decides recency. */
  readonly days?: number[];
  /** open.md rows (day, to); omit for a topic without an open.md. */
  readonly open?: [number, string][];
  readonly index?: boolean;
}

function repository(specs: readonly Spec[]): Record<string, string> {
  const files: Record<string, string> = {
    ".agent-collab": MARKER,
    "index.md": [
      "| topic | title | status |",
      "|---|---|---|",
      ...specs.map((s) => `| ${s.name} | | ${s.status ?? "open"} |`),
    ].join("\n"),
  };
  for (const spec of specs) {
    for (const day of spec.days ?? [1]) {
      files[messagePath(spec.name, day)] = messageText(
        id(spec.name, day),
        "alice-agent",
        spec.name,
        { to: "bob-agent" },
      );
    }
    if (spec.open !== undefined)
      files[`topics/${spec.name}/open.md`] = openFile(spec.name, spec.open);
    if (spec.index !== false)
      files[`topics/${spec.name}/index.md`] = indexFile(spec.name, spec.days ?? [1]);
  }
  return files;
}

async function sessionOf(files: Record<string, string>) {
  const source = new FixtureSource(files);
  const session = new TopicSession(source);
  await session.open();
  return { source, session };
}

const messageReads = (source: FixtureSource) =>
  source.reads.filter((p) => p.includes("/inbox/")).length;

describe("the Attention data layer", () => {
  it("lists the open.md rows addressed to the viewer and reads no message by default", async () => {
    const { source, session } = await sessionOf(
      repository([
        {
          name: "api",
          open: [
            [1, "bob-agent"],
            [2, "alice-agent"],
          ],
        },
        { name: "ops", open: [[1, "bob-agent, alice-agent"]] },
        { name: "idle", open: [] },
      ]),
    );
    const attention = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    expect(attention.rows.map((r) => [r.topic, r.item.id])).toEqual([
      ["api", id("api", 1)],
      ["ops", id("ops", 1)],
    ]);
    expect(attention.rows[0]?.item.section).toBe("Unanswered questions");
    expect(attention.covered).toEqual(["api", "idle", "ops"]);
    expect(attention.followed).toEqual([]);
    expect(attention.messages).toEqual([]);
    // Nothing is followed, so no message file of any topic was read.
    expect(messageReads(source)).toBe(0);
  });

  it("leaves out closed, muted and legacy-only topics, and shows nothing addressed to an Observer", async () => {
    const files = repository([
      { name: "api", open: [[1, "bob-agent"]] },
      { name: "done", status: "closed", open: [[1, "bob-agent"]] },
      { name: "quiet", open: [[1, "bob-agent"]] },
    ]);
    files["index.md"] = `${files["index.md"] ?? ""}\n| old--name | | legacy |`;
    const { source, session } = await sessionOf(files);
    const muted = toggleTopic(EMPTY_TOPIC_PREFERENCES, "mute", "quiet", true);
    const attention = await loadAttention(session, { viewer: "bob-agent", preferences: muted });
    expect(attention.covered).toEqual(["api"]);
    expect(source.reads).not.toContain("topics/done/open.md");
    expect(source.reads).not.toContain("topics/quiet/open.md");
    const observer = await loadAttention(session, {
      viewer: null,
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    expect(observer.rows).toEqual([]);
    expect(observer.covered).toEqual(["api", "quiet"]);
  });

  it("loads the newest page of a followed topic and lists the messages addressed to the viewer", async () => {
    const { source, session } = await sessionOf(
      repository([
        { name: "api", days: [1, 2, 3], open: [] },
        { name: "ops", days: [1, 2], open: [] },
      ]),
    );
    const preferences = toggleTopic(EMPTY_TOPIC_PREFERENCES, "follow", "api", true);
    const attention = await loadAttention(session, { viewer: "bob-agent", preferences });
    expect(attention.followed).toEqual(["api"]);
    expect(attention.messages.map((m) => [m.topic, m.message.id])).toEqual([
      ["api", id("api", 1)],
      ["api", id("api", 2)],
      ["api", id("api", 3)],
    ]);
    // Only the followed topic's messages were read.
    expect(messageReads(source)).toBe(3);
    expect(source.reads.some((p) => p.startsWith("topics/ops/inbox/"))).toBe(false);
    // A followed topic that does not exist is ignored.
    const ghost = toggleTopic(preferences, "follow", "ghost", true);
    expect(
      (await loadAttention(session, { viewer: "bob-agent", preferences: ghost })).followed,
    ).toEqual(["api"]);
  });

  it("says which topics have no usable open.md instead of guessing", async () => {
    const files = repository([
      { name: "api", open: [[1, "bob-agent"]] },
      { name: "old" },
      { name: "huge", open: [] },
    ]);
    files["topics/huge/open.md"] = "x".repeat(3 * 1024 * 1024);
    const { source, session } = await sessionOf(files);
    const attention = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    expect(attention.covered).toEqual(["api"]);
    expect(attention.withoutOpenFile).toEqual(["huge", "old"]);
    expect(source.reads).not.toContain("topics/huge/open.md");
  });

  it("drops hostile rows of an open.md", async () => {
    const files = repository([{ name: "api", open: [[1, "bob-agent"]] }]);
    files["topics/api/open.md"] =
      `${files["topics/api/open.md"] ?? ""}\n| ../../x | alice-agent | bob-agent | a | | s |\n| ${id("ops", 1)} | alice-agent | bob-agent | a | | s |\n`;
    const { session } = await sessionOf(files);
    const attention = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    expect(attention.rows.map((r) => r.item.id)).toEqual([id("api", 1)]);
  });
});

describe("who a row or a message is addressed to", () => {
  it("lists only the named viewer's followed-topic messages, not others' or broadcasts", async () => {
    const files = repository([{ name: "api", days: [1, 2, 3, 4], open: [] }]);
    const to = ["alice-agent", "", "bob-agent", "alice-agent, bob-agent"];
    to.forEach((value, i) => {
      files[messagePath("api", i + 1)] = messageText(id("api", i + 1), "alice-agent", "api", {
        to: value,
      });
    });
    const { session } = await sessionOf(files);
    const preferences = toggleTopic(EMPTY_TOPIC_PREFERENCES, "follow", "api", true);
    const attention = await loadAttention(session, { viewer: "bob-agent", preferences });
    expect(attention.messages.map((m) => m.message.id)).toEqual([id("api", 3), id("api", 4)]);
  });

  it("matches the whole name only, and a broadcast row does not address a person", async () => {
    const files = repository([{ name: "api", open: [] }]);
    files["topics/api/open.md"] = [
      "## Unanswered questions",
      "",
      "| id | from | to | needs | due | 摘要 |",
      "|---|---|---|---|---|---|",
      `| ${id("api", 1)} | alice-agent | bob-agent | a | | s |`,
      `| ${id("api", 2)} | alice-agent | Bob | a | | s |`,
      `| ${id("api", 3)} | alice-agent | all | a | | s |`,
      `| ${id("api", 4)} | alice-agent |  | a | | s |`,
      "",
    ].join("\n");
    const { session } = await sessionOf(files);
    const rows = async (viewer: string) =>
      (await loadAttention(session, { viewer, preferences: EMPTY_TOPIC_PREFERENCES })).rows.map(
        (r) => r.item.id,
      );
    // `bob` is not `bob-agent`, and `Bob` is not a name at all.
    expect(await rows("bob")).toEqual([]);
    expect(await rows("bob-agent")).toEqual([id("api", 1)]);
    // A broadcast (blank, or "all") is for everyone, so it is not "addressed to" anyone here: the
    // design lists rows that name the viewer; waiting-for-anyone items stay in the topic.
    expect(await rows("all")).toEqual([id("api", 3)]);
    expect(await rows("alice-agent")).toEqual([]);
  });

  it("ignores a topic the index lists as open when it has no folder", async () => {
    const files = repository([{ name: "api", open: [[1, "bob-agent"]] }]);
    files["index.md"] = `${files["index.md"] ?? ""}\n| ghost | | open |`;
    const { session } = await sessionOf(files);
    expect(session.topics().map((t) => t.name)).toEqual(["api"]);
    const preferences = toggleTopic(EMPTY_TOPIC_PREFERENCES, "follow", "ghost", true);
    const attention = await loadAttention(session, { viewer: "bob-agent", preferences });
    expect(attention.covered).toEqual(["api"]);
    expect(attention.followed).toEqual([]);
  });
});

describe("the open.md cache by tree id", () => {
  it("a second call reads no open.md and lists no topic folder again", async () => {
    const { source, session } = await sessionOf(
      repository([
        { name: "api", open: [[1, "bob-agent"]] },
        { name: "ops", open: [[1, "bob-agent"]] },
      ]),
    );
    const first = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    const reads = source.reads.filter((p) => p.endsWith("/open.md")).length;
    const listings = source.listings.filter((p) => p.startsWith("topics/")).length;
    expect(reads).toBe(2);
    const second = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    expect(second.rows).toEqual(first.rows);
    expect(source.reads.filter((p) => p.endsWith("/open.md"))).toHaveLength(reads);
    expect(source.listings.filter((p) => p.startsWith("topics/"))).toHaveLength(listings);
  });
});

describe("the limit on topics read", () => {
  const specs = (count: number): Spec[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `topic-${String(i).padStart(2, "0")}`,
      // Later topics are more recently active.
      days: [1 + (i % 28)],
      open: [[1 + (i % 28), "bob-agent"]],
    }));

  it("ranks by recency exactly when the digests are already known, and reports the rest as skipped", async () => {
    expect(ATTENTION_TOPIC_LIMIT).toBe(30);
    const all = specs(40);
    const { source, session } = await sessionOf(repository(all));
    // The topic list already knows every digest (it showed them).
    for (const spec of all) await session.digest(spec.name);
    const attention = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    expect(attention.covered).toHaveLength(30);
    expect(attention.skipped).toHaveLength(10);
    const newestDay = (t: string) => Number(t.slice("topic-".length)) % 28;
    expect(Math.min(...attention.covered.map(newestDay))).toBeGreaterThanOrEqual(
      Math.max(...attention.skipped.map(newestDay)),
    );
    expect(source.reads.filter((p) => p.endsWith("/open.md"))).toHaveLength(30);
  });

  it("above the limit, recency is best effort: at most the limit of fresh digests, then it converges", async () => {
    const { source, session } = await sessionOf(repository(specs(40)));
    const digestReads = () =>
      source.reads.filter((p) => p.endsWith("/index.md") && p !== "index.md").length;
    const first = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    // Only 30 topics (the first 30 by name) were ranked; the other 10 are skipped, not guessed.
    expect(digestReads()).toBe(30);
    expect(first.covered).toHaveLength(30);
    expect(first.skipped).toHaveLength(10);
    // The next call ranks the 10 left over too, now from the cache plus 10 fresh digests.
    const second = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    expect(digestReads()).toBe(40);
    expect(second.covered).toHaveLength(30);
  });

  it("reads them all when asked, and honors another limit", async () => {
    const { source, session } = await sessionOf(repository(specs(40)));
    const everything = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
      all: true,
    });
    expect(everything.covered).toHaveLength(40);
    expect(everything.skipped).toEqual([]);
    expect(source.reads.filter((p) => p.endsWith("/open.md"))).toHaveLength(40);
    const few = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
      limit: 5,
    });
    expect(few.covered).toHaveLength(5);
  });

  it("needs no recency at all up to the limit", async () => {
    const { source, session } = await sessionOf(repository(specs(12)));
    await loadAttention(session, { viewer: "bob-agent", preferences: EMPTY_TOPIC_PREFERENCES });
    expect(source.reads.filter((p) => p.endsWith("/index.md") && p !== "index.md")).toEqual([]);
  });
});

describe("requests through the provider", () => {
  const github = (server: ReturnType<typeof git>) =>
    new GitHubSource({
      apiBase: API,
      owner: "alice-org",
      repo: "collab",
      branch: "main",
      token: new Secret("test-token-not-real"),
      fetch: server.fetch,
    });
  const without = (count: number): Spec[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `t-${String(i).padStart(4, "0")}`,
      index: false,
    }));

  it("costs a bounded number of requests above the limit, whatever the number of topics", async () => {
    const counts: number[] = [];
    for (const topics of [40, 200]) {
      const server = git(repository(without(topics)));
      const session = new TopicSession(github(server));
      await session.open();
      server.requests.length = 0;
      const attention = await loadAttention(session, {
        viewer: "bob-agent",
        preferences: EMPTY_TOPIC_PREFERENCES,
      });
      counts.push(server.requests.length);
      // Only the ranked topics were read; every other open topic is reported as skipped.
      expect(attention.covered.length + attention.withoutOpenFile.length).toBe(30);
      expect(attention.skipped).toHaveLength(topics - 30);
    }
    // 30 fresh digests, each the topic's tree, its inbox and its newest month (no index.md), and
    // nothing for the rest: the same count for 40 topics and for 200.
    expect(counts).toEqual([90, 90]);
  });

  const twelve = (): Spec[] =>
    Array.from({ length: 12 }, (_, i) => ({
      name: `topic-${String(i)}`,
      status: i === 3 ? ("closed" as const) : ("open" as const),
      open: [[1, "bob-agent"]],
    }));

  it("costs a tree and a blob per open topic, nothing for closed ones, and nothing the second time", async () => {
    const server = git(repository(twelve()));
    const session = new TopicSession(github(server));
    await session.open();
    server.requests.length = 0;
    const first = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    expect(first.rows).toHaveLength(11);
    const expected = twelve()
      .filter((spec) => spec.status !== "closed")
      .flatMap((spec) => [
        `/git/trees/${server.sha(`topics/${spec.name}`)}`,
        `/git/blobs/${server.sha(`topics/${spec.name}/open.md`)}`,
      ]);
    expect([...server.requests].sort()).toEqual([...expected].sort());
    expect(REPO).toContain("/repos/");

    server.requests.length = 0;
    await loadAttention(session, { viewer: "bob-agent", preferences: EMPTY_TOPIC_PREFERENCES });
    expect(server.requests).toEqual([]);
  });

  it("after a change in one topic, only that topic is read again", async () => {
    const files = repository(twelve());
    const server = git(files);
    const session = new TopicSession(github(server));
    await session.open();
    await loadAttention(session, { viewer: "bob-agent", preferences: EMPTY_TOPIC_PREFERENCES });
    server.commit({
      ...files,
      "topics/topic-5/open.md": openFile("topic-5", [
        [1, "bob-agent"],
        [2, "bob-agent"],
      ]),
    });
    await session.refresh();
    server.requests.length = 0;
    const next = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    expect(next.rows.filter((r) => r.topic === "topic-5")).toHaveLength(2);
    expect(server.requests).toEqual([
      `/git/trees/${server.sha("topics/topic-5")}`,
      `/git/blobs/${server.sha("topics/topic-5/open.md")}`,
    ]);
  });
});

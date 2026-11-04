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

describe("the limit on topics read", () => {
  const specs = (count: number): Spec[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `topic-${String(i).padStart(2, "0")}`,
      // Later topics are more recently active.
      days: [1 + (i % 28)],
      open: [[1 + (i % 28), "bob-agent"]],
    }));

  it("reads at most the most recently active open topics and reports the rest as skipped", async () => {
    expect(ATTENTION_TOPIC_LIMIT).toBe(30);
    const all = specs(40);
    const { source, session } = await sessionOf(repository(all));
    const attention = await loadAttention(session, {
      viewer: "bob-agent",
      preferences: EMPTY_TOPIC_PREFERENCES,
    });
    expect(attention.covered).toHaveLength(30);
    expect(attention.skipped).toHaveLength(10);
    const newestDay = (t: string) => Number(t.slice("topic-".length)) % 28;
    const readMin = Math.min(...attention.covered.map(newestDay));
    const skippedMax = Math.max(...attention.skipped.map(newestDay));
    expect(readMin).toBeGreaterThanOrEqual(skippedMax);
    expect(source.reads.filter((p) => p.endsWith("/open.md"))).toHaveLength(30);
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

import { describe, expect, it } from "vitest";

import { sortTopicSummaries, readTopicActivity } from "../src/loader/topic-activity";
import { readTopicList, topicLoader } from "../src/loader/topic-reader";
import type { TopicSummary } from "../src/message/topic-layout";
import { FixtureSource } from "../src/source/fixture";
import { GitHubSource } from "../src/source/github";

const topics: TopicSummary[] = [
  { name: "zeta", title: "Zeta", status: "open", folder: true },
  { name: "alpha", title: null, status: "open", folder: true },
  { name: "beta", title: null, status: "open", folder: true },
  { name: "closed-old", title: null, status: "closed", folder: true },
  { name: "legacy", title: "Legacy", status: "legacy", folder: false },
  { name: "closed-new", title: null, status: "closed", folder: true },
];

describe("topic activity", () => {
  it("orders by latest month and file, then name, with closed topics last", () => {
    expect(
      sortTopicSummaries(
        topics,
        new Map([
          ["zeta", { month: "2026-08", fileName: "z.md" }],
          ["alpha", { month: "2026-09", fileName: "a.md" }],
          ["beta", { month: "2026-09", fileName: "z.md" }],
          ["closed-old", { month: "2026-07", fileName: "z.md" }],
          ["closed-new", { month: "2026-10", fileName: "a.md" }],
        ]),
      ).map(({ name }) => name),
    ).toEqual(["beta", "alpha", "zeta", "legacy", "closed-new", "closed-old"]);
  });

  it("uses the newest month and filename and never reads a message file", async () => {
    const source = new FixtureSource({
      ".agent-collab": "collab-protocol: 1\ninbox-layout: topic\n",
      "topics/api/TOPIC.md": "---\ntitle: API\n---\n",
      "topics/api/inbox/2026-01/old.md": "message body",
      "topics/api/inbox/2026-03/2026-03-a.md": "message body",
      "topics/api/inbox/2026-03/2026-03-z.md": "message body",
    });
    const calls: string[] = [];
    const list = source.listDirectory.bind(source);
    source.listDirectory = async (revision, path) => {
      calls.push(path);
      return list(revision, path);
    };
    const activity = await readTopicActivity(source, "revision", {
      name: "api",
      title: "API",
      status: "open",
      folder: true,
    });

    expect(activity).toEqual({ month: "2026-03", fileName: "2026-03-z.md" });
    expect(calls).toEqual(["topics/api", "topics/api/inbox", "topics/api/inbox/2026-03"]);
    expect(calls.some((path) => path.endsWith(".md"))).toBe(false);
  });

  it("uses the real GitHub source and lists only the selected topic's activity trees", async () => {
    const requests: string[] = [];
    const tree = (entries: readonly { path: string; type: "tree" | "blob"; sha: string }[]) =>
      new Response(
        JSON.stringify({
          truncated: false,
          tree: entries.map((entry) => ({
            mode: entry.type === "tree" ? "040000" : "100644",
            ...entry,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const github = new GitHubSource({
      apiBase: "https://api.github.com",
      owner: "alice-agent",
      repo: "fixture-repo",
      branch: "main",
      token: null,
      fetch: async (input) => {
        await Promise.resolve();
        const requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(requestUrl);
        requests.push(url.pathname);
        const path = url.pathname;
        if (path.endsWith("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: "rev" } }), { status: 200 });
        }
        if (path.endsWith("/git/commits/rev")) {
          return new Response(JSON.stringify({ tree: { sha: "root" } }), { status: 200 });
        }
        if (path.endsWith("/git/trees/root")) {
          return tree([
            { path: ".agent-collab", type: "blob", sha: "marker" },
            { path: "topics", type: "tree", sha: "topics" },
            { path: "index.md", type: "blob", sha: "index" },
          ]);
        }
        if (path.endsWith("/git/trees/topics")) {
          return tree([
            { path: "api", type: "tree", sha: "api" },
            { path: "ops", type: "tree", sha: "ops" },
          ]);
        }
        if (path.endsWith("/git/trees/api")) {
          return tree([{ path: "inbox", type: "tree", sha: "api-inbox" }]);
        }
        if (path.endsWith("/git/trees/api-inbox")) {
          return tree([{ path: "2026-03", type: "tree", sha: "api-month" }]);
        }
        if (path.endsWith("/git/trees/api-month")) {
          return tree([
            {
              path: "2026-03-01T0900-alice-agent-api-01.md",
              type: "blob",
              sha: "message",
            },
          ]);
        }
        if (path.endsWith("/git/blobs/marker")) {
          return new Response("collab-protocol: 1\ninbox-layout: topic\n", { status: 200 });
        }
        if (path.endsWith("/git/blobs/index")) {
          return new Response("| topic | title | status |\n|---|---|---|\n| api | API | open |", {
            status: 200,
          });
        }
        if (path.endsWith("/git/blobs/message")) {
          return new Response(
            [
              "---",
              "id: 2026-03-01T0900-alice-agent-api-01",
              "from: alice-agent",
              "to: bob-agent",
              "topic: api",
              "type: info",
              "needs: none",
              "---",
              "A selected topic message.",
            ].join("\n"),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    });

    const list = await readTopicList(github);
    const listRequests = requests.length;
    const selected = list.topics.find((topic) => topic.name === "api");
    expect(selected).toBeDefined();
    if (selected === undefined) throw new Error("API topic is missing from the fixture.");
    await readTopicActivity(github, "rev", selected);
    await topicLoader(github, "api").openWithHead(list.head);

    expect(listRequests).toBe(6);
    expect(requests.length).toBe(10);
    expect(requests.filter((path) => path.includes("/git/blobs/")).sort()).toEqual([
      "/repos/alice-agent/fixture-repo/git/blobs/index",
      "/repos/alice-agent/fixture-repo/git/blobs/marker",
      "/repos/alice-agent/fixture-repo/git/blobs/message",
    ]);
    expect(requests.some((path) => path.endsWith("/git/trees/ops"))).toBe(false);
  });
});

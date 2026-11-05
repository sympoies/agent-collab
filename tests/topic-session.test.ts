// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { Secret } from "../src/credentials/secret";
import { TopicSession } from "../src/loader/topic-session";
import { FixtureSource } from "../src/source/fixture";
import { GitHubSource } from "../src/source/github";
import { TopicLayoutSource } from "../src/source/topic-layout";
import { mergeRosterSnapshot, mergeSnapshots } from "../src/ui/merged-snapshot";
import { messageText } from "./support";

const MARKER = "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n";
const TOPICS = Array.from({ length: 12 }, (_, i) => `topic-${String(i)}`);

const id = (topic: string, day: number) =>
  `2026-11-${String(day).padStart(2, "0")}T0900-alice-agent-${topic}-01`;
const path = (topic: string, day: number) => `topics/${topic}/inbox/2026-11/${id(topic, day)}.md`;

function topicFiles(topic: string, days: number[]): Record<string, string> {
  return Object.fromEntries(
    days.map((d) => [path(topic, d), messageText(id(topic, d), "alice-agent", topic)]),
  );
}

/** A repository of 12 topics with two messages each, plus an index with a closed topic. */
function repository(extra: Record<string, string> = {}): Record<string, string> {
  const rows = TOPICS.map((t, i) => `| ${t} | Title ${t} | ${i === 2 ? "closed" : "open"} |`).join(
    "\n",
  );
  return {
    ".agent-collab": MARKER,
    "index.md": `| topic | title | status |\n|---|---|---|\n${rows}\n`,
    ...Object.fromEntries(TOPICS.flatMap((t) => Object.entries(topicFiles(t, [1, 2])))),
    ...extra,
  };
}

const touched = (source: FixtureSource, topic: string) =>
  [...source.listings, ...source.reads].filter((p) => p.startsWith(`topics/${topic}/`)).length;

describe("the topic session", () => {
  it("lists the topics with titles and the closed one after open", async () => {
    const session = new TopicSession(new FixtureSource(repository()));
    await session.open();
    expect(session.topics()).toHaveLength(12);
    expect(session.topics().find((t) => t.name === "topic-2")).toMatchObject({
      title: "Title topic-2",
      status: "closed",
    });
    expect(session.inboxLayout).toBe("topic");
  });

  it("exposes roster metadata from the topic list before any topic messages are opened", async () => {
    const source = new FixtureSource({
      ...repository(),
      ".agent-collab": `${MARKER}former-participants: carol-agent\n`,
    });
    const session = new TopicSession(source);
    await session.open();

    expect(session.rosterSnapshot).toEqual({
      participants: ["alice-agent", "bob-agent"],
      formerParticipants: ["carol-agent"],
      rosterKnown: true,
    });
    expect(source.listings.some((path) => path.startsWith("topics/topic-1/inbox/"))).toBe(false);
  });

  it("uses the current root roster when unchanged topic loaders retain an older marker", async () => {
    const source = new FixtureSource(repository());
    const session = new TopicSession(source);
    await session.open();
    const loader = session.loader("topic-1");
    await loader.open();

    source.commit({
      ...repository(),
      ".agent-collab":
        "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent\nformer-participants: bob-agent\n",
    });
    expect(await session.refresh()).toEqual([]);
    expect(loader.getSnapshot().participants).toEqual(["alice-agent", "bob-agent"]);

    const merged = mergeRosterSnapshot(
      mergeSnapshots([loader.getSnapshot()]),
      session.rosterSnapshot,
    );
    expect(merged.participants).toEqual(["alice-agent"]);
    expect(merged.formerParticipants).toEqual(["bob-agent"]);
  });

  it("keeps a loader per topic for the session", async () => {
    const session = new TopicSession(new FixtureSource(repository()));
    await session.open();
    expect(session.loader("topic-1")).toBe(session.loader("topic-1"));
    expect(session.loader("topic-1")).not.toBe(session.loader("topic-3"));
  });

  it("an unchanged repository costs one conditional request and touches no topic", async () => {
    const source = new FixtureSource(repository());
    const session = new TopicSession(source);
    await session.open();
    const loader = session.loader("topic-1");
    await loader.open();
    const before = [...source.listings, ...source.reads];
    expect(await session.refresh()).toEqual([]);
    expect([...source.listings, ...source.reads]).toEqual(before);
  });

  it("a change in one topic refreshes only that topic's loader; closed and idle topics make no request", async () => {
    const source = new FixtureSource(repository());
    const session = new TopicSession(source);
    await session.open();
    for (const t of ["topic-1", "topic-2", "topic-5"]) await session.loader(t).open();
    const idleBefore = ["topic-1", "topic-2", "topic-5", "topic-7"].map((t) => touched(source, t));

    source.commit(repository(topicFiles("topic-5", [3])));
    expect(await session.refresh()).toEqual(["topic-5"]);
    expect(session.loader("topic-5").getSnapshot().items).toHaveLength(3);

    const idleAfter = ["topic-1", "topic-2", "topic-5", "topic-7"].map((t) => touched(source, t));
    // topic-1 (idle, open), topic-2 (closed) and topic-7 (never opened) are not read again; only
    // the changed topic is, and listing the topics directory costs one listing for all of them.
    expect(idleAfter[0]).toBe(idleBefore[0]);
    expect(idleAfter[1]).toBe(idleBefore[1]);
    expect(idleAfter[3]).toBe(idleBefore[3]);
    expect(idleAfter[2]).toBeGreaterThan(idleBefore[2] as number);
    // Their loaders still hold what they loaded.
    expect(session.loader("topic-2").getSnapshot().items).toHaveLength(2);
  });

  it("a loader that fails to refresh does not stop the others and is retried without a new commit", async () => {
    const source = new FixtureSource(repository());
    const session = new TopicSession(source);
    await session.open();
    await session.loader("topic-5").open();
    await session.loader("topic-6").open();
    source.commit(repository({ ...topicFiles("topic-5", [3]), ...topicFiles("topic-6", [3]) }));
    source.failListings(["topics/topic-5/inbox"]);
    await expect(session.refresh()).rejects.toMatchObject({ kind: "unreachable" });
    // The other changed topic still refreshed; the failed one is behind.
    expect(session.loader("topic-6").getSnapshot().items).toHaveLength(3);
    expect(session.loader("topic-5").getSnapshot().items).toHaveLength(2);
    // Nothing new in the repository, yet the next refresh catches the failed topic up.
    source.failListings([]);
    expect(await session.refresh()).toEqual(["topic-5"]);
    expect(session.loader("topic-5").getSnapshot().items).toHaveLength(3);
    expect(await session.refresh()).toEqual([]);
  });

  it("gathers several loader failures into one error after the others finished", async () => {
    const source = new FixtureSource(repository());
    const session = new TopicSession(source);
    await session.open();
    for (const t of ["topic-4", "topic-5", "topic-6"]) await session.loader(t).open();
    source.commit(
      repository({
        ...topicFiles("topic-4", [3]),
        ...topicFiles("topic-5", [3]),
        ...topicFiles("topic-6", [3]),
      }),
    );
    source.failListings(["topics/topic-4/inbox", "topics/topic-5/inbox"]);
    const error = (await session.refresh().catch((reason: unknown) => reason)) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(2);
    expect(session.loader("topic-6").getSnapshot().items).toHaveLength(3);
  });

  it("reports a new topic and a removed topic, and drops the loader of a removed one", async () => {
    const source = new FixtureSource(repository());
    const session = new TopicSession(source);
    await session.open();
    await session.loader("topic-4").open();
    const files = repository(topicFiles("fresh", [1]));
    source.commit(
      Object.fromEntries(
        Object.entries(files).filter(([key]) => !key.startsWith("topics/topic-4/")),
      ),
    );
    expect(await session.refresh()).toEqual(["fresh", "topic-4"]);
    expect(session.topics().map((t) => t.name)).toContain("fresh");
    expect(session.topics().map((t) => t.name)).not.toContain("topic-4");
  });

  it("re-reads the root index only when it changed", async () => {
    const source = new FixtureSource(repository());
    const session = new TopicSession(source);
    await session.open();
    const reads = () => source.reads.filter((p) => p === "index.md").length;
    expect(reads()).toBe(1);
    source.commit(repository(topicFiles("topic-0", [3])));
    await session.refresh();
    expect(reads()).toBe(1);
    source.commit({
      ...repository(),
      "index.md": "| topic | title | status |\n|---|---|---|\n| topic-0 | New | open |\n",
    });
    await session.refresh();
    expect(reads()).toBe(2);
    expect(session.topics().find((t) => t.name === "topic-0")?.title).toBe("New");
  });

  it("stores nothing in the browser: a private repository stays in memory", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const source = new FixtureSource(repository());
    const session = new TopicSession(source);
    await session.open();
    await session.loader("topic-1").open();
    await session.digest("topic-1");
    source.commit(repository(topicFiles("topic-1", [3])));
    await session.refresh();
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    setItem.mockRestore();
    getItem.mockRestore();
  });
});

describe("the digest of a topic", () => {
  const indexFor = (topic: string, days: number[]) =>
    [
      "| id | from | to | type | topic | reply_to | needs | 摘要 |",
      "|---|---|---|---|---|---|---|---|",
      ...days.map(
        (d) => `| ${id(topic, d)} | alice-agent | bob-agent | info | ${topic} |  | none | s |`,
      ),
    ].join("\n");

  it("uses the topic's index.md for the count and the newest id, and caches it by tree id", async () => {
    const source = new FixtureSource(
      repository({ "topics/topic-1/index.md": indexFor("topic-1", [1, 2]) }),
    );
    const session = new TopicSession(source);
    await session.open();
    expect(await session.digest("topic-1")).toEqual({
      count: 2,
      newestId: id("topic-1", 2),
      fromIndex: true,
      ids: [id("topic-1", 1), id("topic-1", 2)],
    });
    const indexReads = () => source.reads.filter((p) => p === "topics/topic-1/index.md").length;
    expect(indexReads()).toBe(1);
    expect(await session.digest("topic-1")).toMatchObject({ count: 2 });
    expect(indexReads()).toBe(1);
    // A change elsewhere keeps it; a change in the topic reads it again.
    source.commit(
      repository({
        "topics/topic-1/index.md": indexFor("topic-1", [1, 2]),
        ...topicFiles("topic-9", [3]),
      }),
    );
    await session.refresh();
    await session.digest("topic-1");
    expect(indexReads()).toBe(1);
    source.commit(
      repository({
        ...topicFiles("topic-1", [3]),
        "topics/topic-1/index.md": indexFor("topic-1", [1, 2, 3]),
      }),
    );
    await session.refresh();
    expect(await session.digest("topic-1")).toMatchObject({
      count: 3,
      newestId: id("topic-1", 3),
      fromIndex: true,
    });
  });

  it("falls back to the listing when the index is missing, hostile or oversized, and never guesses a count", async () => {
    for (const index of [
      undefined,
      "garbage",
      indexFor("other", [1]),
      "x".repeat(3 * 1024 * 1024),
    ]) {
      const source = new FixtureSource(
        repository(index === undefined ? {} : { "topics/topic-1/index.md": index }),
      );
      const session = new TopicSession(source);
      await session.open();
      expect(await session.digest("topic-1"), String(index?.slice(0, 8))).toEqual({
        count: null,
        newestId: id("topic-1", 2),
        fromIndex: false,
      });
      // The oversized file is not even read.
      if (index !== undefined && index.length > 1024 * 1024) {
        expect(source.reads).not.toContain("topics/topic-1/index.md");
      }
    }
  });

  it("has nothing to say about a topic without a folder or a name that is not one", async () => {
    const session = new TopicSession(new FixtureSource(repository()));
    await session.open();
    expect(await session.digest("ghost")).toEqual({
      count: null,
      newestId: null,
      fromIndex: false,
    });
    expect(await session.digest("../x")).toEqual({ count: null, newestId: null, fromIndex: false });
  });
});

describe("requests through the provider when one of twelve topics changes", () => {
  const API = "https://api.example.test";
  const REPO = `${API}/repos/alice-org/collab`;

  /** A tiny git server over a files map: trees and blobs are named by hashes of their content. */
  function git(files: Record<string, string>) {
    let current = files;
    let revision = 1;
    const requests: string[] = [];
    /** For each ref request: the validator it sent and the status it got. */
    const refs: { ifNoneMatch: string | null; status: number }[] = [];
    const hash = (text: string) => {
      let value = 0x811c9dc5;
      for (let i = 0; i < text.length; i += 1)
        value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
      return (value >>> 0).toString(16).padStart(8, "0");
    };
    const trees = new Map<
      string,
      { path: string; type: string; sha: string; mode: string; size?: number }[]
    >();
    const blobs = new Map<string, string>();
    /** The sha of every directory and file by path, for naming expected requests. */
    const shas = new Map<string, string>();
    const build = (dir: string): string => {
      const names = new Map<string, "blob" | "tree">();
      const prefix = dir === "" ? "" : `${dir}/`;
      for (const file of Object.keys(current)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? "blob" : "tree");
      }
      const entries = [...names].sort().map(([name, type]) => {
        const sha =
          type === "tree" ? build(`${prefix}${name}`) : hash(current[`${prefix}${name}`] ?? "");
        if (type === "blob") blobs.set(sha, current[`${prefix}${name}`] ?? "");
        shas.set(`${prefix}${name}`, sha);
        const size = new TextEncoder().encode(current[`${prefix}${name}`] ?? "").length;
        return { path: name, type, sha, mode: type === "tree" ? "040000" : "100644", size };
      });
      const sha = hash(JSON.stringify(entries));
      trees.set(sha, entries);
      shas.set(dir, sha);
      return sha;
    };
    let root = build("");
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      });
    const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const route = (input instanceof Request ? input.url : input.toString()).slice(REPO.length);
      requests.push(route);
      if (route.startsWith("/git/ref/heads/")) {
        const etag = `"r${String(revision)}"`;
        const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
        if (ifNoneMatch === etag) {
          refs.push({ ifNoneMatch, status: 304 });
          return Promise.resolve(new Response(null, { status: 304 }));
        }
        refs.push({ ifNoneMatch, status: 200 });
        return Promise.resolve(json({ object: { sha: `r${String(revision)}` } }, { etag }));
      }
      if (route.startsWith("/git/commits/")) return Promise.resolve(json({ tree: { sha: root } }));
      const tree = /^\/git\/trees\/(.+)$/.exec(route)?.[1];
      if (tree !== undefined)
        return Promise.resolve(json({ truncated: false, tree: trees.get(tree) }));
      const blob = /^\/git\/blobs\/(.+)$/.exec(route)?.[1];
      if (blob !== undefined) return Promise.resolve(new Response(blobs.get(blob) ?? ""));
      throw new Error(`unexpected request: ${route}`);
    };
    return {
      fetch,
      requests,
      refs,
      commit: (next: Record<string, string>) => {
        current = next;
        revision += 1;
        trees.clear();
        shas.clear();
        root = build("");
      },
      sha: (path: string) => shas.get(path) ?? "missing",
      etag: () => `"r${String(revision)}"`,
    };
  }

  const github = (server: ReturnType<typeof git>) =>
    new GitHubSource({
      apiBase: API,
      owner: "alice-org",
      repo: "collab",
      branch: "main",
      token: new Secret("test-token-not-real"),
      fetch: server.fetch,
    });
  const R = "/git/ref/heads/main";
  const tree = (sha: string) => `/git/trees/${sha}`;
  const blob = (sha: string) => `/git/blobs/${sha}`;

  it("an unchanged repository is exactly one conditional ref request, answered 304", async () => {
    const server = git(repository());
    const session = new TopicSession(github(server));
    await session.open();
    for (const t of ["topic-1", "topic-2", "topic-5"]) await session.loader(t).open();
    server.requests.length = 0;
    server.refs.length = 0;
    expect(await session.refresh()).toEqual([]);
    expect(server.requests).toEqual([R]);
    expect(server.refs).toEqual([{ ifNoneMatch: server.etag(), status: 304 }]);
  });

  it("one changed topic of twelve costs exactly these requests and no other topic's", async () => {
    const server = git(repository());
    const session = new TopicSession(github(server));
    await session.open();
    for (const t of ["topic-1", "topic-2", "topic-5"]) await session.loader(t).open();
    server.requests.length = 0;

    const added = path("topic-5", 3);
    server.commit(repository(topicFiles("topic-5", [3])));
    expect(await session.refresh()).toEqual(["topic-5"]);
    expect(server.requests).toEqual([
      // The session: the moved head, its commit, the root tree and the topics/ tree.
      R,
      "/git/commits/r2",
      tree(server.sha("")),
      tree(server.sha("topics")),
      // The changed topic's loader: its own head check, then only the trees that changed.
      R,
      tree(server.sha("topics/topic-5")),
      tree(server.sha("topics/topic-5/inbox")),
      tree(server.sha("topics/topic-5/inbox/2026-11")),
      // The one new message.
      blob(server.sha(added)),
    ]);
  });

  it("does not use browser storage, IndexedDB or the Cache API, through the provider", async () => {
    const opened = vi.fn();
    const cacheOpened = vi.fn();
    vi.stubGlobal("indexedDB", { open: opened });
    vi.stubGlobal("caches", { open: cacheOpened });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const server = git(repository());
    const session = new TopicSession(github(server));
    await session.open();
    await session.loader("topic-5").open();
    await session.digest("topic-5");
    server.commit(repository(topicFiles("topic-5", [3])));
    await session.refresh();
    expect(opened).not.toHaveBeenCalled();
    expect(cacheOpened).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
    vi.unstubAllGlobals();
  });

  it("two topic folders with the same content (same tree id) are each listed from their own path", async () => {
    // Only an identical TOPIC.md and an identical .gitkeep: the two trees have the same sha.
    const same = (topic: string) => ({
      [`topics/${topic}/TOPIC.md`]: "---\ntitle: Same\n---\n",
      [`topics/${topic}/inbox/2026-11/.gitkeep`]: "",
    });
    const files = { ".agent-collab": MARKER, ...same("a"), ...same("b") };
    const server = git(files);
    expect(server.sha("topics/a")).toBe(server.sha("topics/b"));
    const source = new TopicLayoutSource(github(server));
    const head = await source.head(null);
    if (head === "not-modified") throw new Error("not expected");
    await source.listDirectory(head.revision, "");
    const month = await source.listDirectory(head.revision, "inbox/2026-11");
    expect(month.map((entry) => entry.path).sort()).toEqual([
      "topics/a/inbox/2026-11/.gitkeep",
      "topics/b/inbox/2026-11/.gitkeep",
    ]);

    // A message in a: its listing, its loader and the digest come from a, and b stays empty.
    const session = new TopicSession(github(git(files)));
    await session.open();
    expect(session.topics().map((t) => t.name)).toEqual(["a", "b"]);
    const next = { ...files, ...topicFiles("a", [3]) };
    const later = git(files);
    const second = new TopicSession(github(later));
    await second.open();
    await second.loader("a").open();
    await second.loader("b").open();
    later.commit(next);
    expect(await second.refresh()).toEqual(["a"]);
    expect(second.loader("a").getSnapshot().items).toHaveLength(1);
    expect(second.loader("b").getSnapshot().items).toEqual([]);
    expect(await second.digest("b")).toEqual({ count: null, newestId: null, fromIndex: false });
    expect(await second.digest("a")).toMatchObject({ newestId: id("a", 3), fromIndex: false });
  });

  it("does not fetch an oversized index.md: the size comes from the listing", async () => {
    const big = "| id |\n|---|\n" + "x".repeat(3 * 1024 * 1024);
    const server = git(repository({ "topics/topic-1/index.md": big }));
    const session = new TopicSession(github(server));
    await session.open();
    server.requests.length = 0;
    expect(await session.digest("topic-1")).toMatchObject({
      count: null,
      newestId: id("topic-1", 2),
    });
    expect(server.requests).not.toContain(blob(server.sha("topics/topic-1/index.md")));
  });
});

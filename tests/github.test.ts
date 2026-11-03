import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { Secret } from "../src/credentials/secret";
import { Loader } from "../src/loader/loader";
import { GitHubSource, type GitHubSourceConfig } from "../src/source/github";
import { SourceError } from "../src/source/types";
import { messageText } from "./support";

// Obvious fake; tests assert it never leaks into errors, URLs or serialized state.
const TOKEN = "test-token-not-real";
const API = "https://api.github.example";
const REPO = `${API}/repos/alice-org/collab`;
const RATE = {
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4990",
  "x-ratelimit-reset": "1793600000",
};

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

type Reply = Response | (() => Response) | Error;

/** A fetch stand-in that only answers the routes a test registers. */
function fakeFetch(routes: Record<string, Reply | Reply[]>) {
  const calls: Recorded[] = [];
  const queues = new Map(
    Object.entries(routes).map(([url, reply]) => [
      url,
      Array.isArray(reply) ? [...reply] : [reply],
    ]),
  );
  const fetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const queue = queues.get(url);
    const reply = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (reply === undefined) throw new Error(`unexpected request: ${url}`);
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(typeof reply === "function" ? reply() : reply.clone());
  };
  return { fetch, calls };
}

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...RATE, ...headers },
  });
}

function raw(text: string): Response {
  return new Response(text, { status: 200, headers: RATE });
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(code === 304 ? null : JSON.stringify({ message: "error" }), {
    status: code,
    headers: { ...RATE, ...headers },
  });
}

function source(fetch: typeof globalThis.fetch, overrides: Partial<GitHubSourceConfig> = {}) {
  return new GitHubSource({
    apiBase: API,
    owner: "alice-org",
    repo: "collab",
    branch: "main",
    token: new Secret(TOKEN),
    fetch,
    now: () => new Date("2026-11-02T00:00:00Z"),
    ...overrides,
  });
}

function header(call: Recorded | undefined, name: string): string | null {
  return new Headers(call?.init.headers).get(name);
}

const tree = (
  entries: { path: string; type: string; sha: string; mode?: string }[],
  truncated = false,
) =>
  json({
    sha: "unused",
    truncated,
    tree: entries.map((entry) => ({ mode: entry.type === "tree" ? "040000" : "100644", ...entry })),
  });

describe("GitHubSource configuration", () => {
  it("refuses an API base that is not https", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => source(fetch, { apiBase: "http://api.github.example" })).toThrow(
      "The API endpoint must use https.",
    );
    expect(() => source(fetch, { apiBase: "not a url" })).toThrow(
      "The API endpoint must use https.",
    );
  });
});

describe("GitHubSource.head", () => {
  it("reads the branch ref with a bearer token and remembers the ETag", async () => {
    const { fetch, calls } = fakeFetch({
      [`${REPO}/git/ref/heads/main`]: json(
        { object: { sha: "c1", type: "commit" } },
        { etag: '"e1"' },
      ),
    });
    expect(await source(fetch).head(null)).toEqual({ revision: "c1", validator: '"e1"' });
    expect(header(calls[0], "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(header(calls[0], "if-none-match")).toBeNull();
    expect(calls[0]?.init.cache).toBe("no-store");
    expect(calls[0]?.init.credentials).toBe("omit");
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("sends If-None-Match and reports not-modified on 304", async () => {
    const { fetch, calls } = fakeFetch({ [`${REPO}/git/ref/heads/main`]: status(304) });
    expect(await source(fetch).head({ revision: "c1", validator: '"e1"' })).toBe("not-modified");
    expect(header(calls[0], "if-none-match")).toBe('"e1"');
  });

  it("supports anonymous requests without an Authorization header", async () => {
    const { fetch, calls } = fakeFetch({
      [`${REPO}/git/ref/heads/main`]: json({ object: { sha: "c1" } }, { etag: '"e1"' }),
    });
    const github = source(fetch, { token: null });
    expect(await github.head(null)).toEqual({ revision: "c1", validator: '"e1"' });
    expect(header(calls[0], "authorization")).toBeNull();
    expect(header(calls[0], "accept")).toBe("application/vnd.github+json");
    expect(header(calls[0], "x-github-api-version")).toBe("2022-11-28");
  });

  it("keeps anonymous manual refreshes conditional", async () => {
    const { fetch, calls } = fakeFetch({
      [`${REPO}/git/ref/heads/main`]: status(304),
    });
    const github = source(fetch, { token: null });
    expect(await github.head({ revision: "c1", validator: '"e1"' })).toBe("not-modified");
    expect(header(calls[0], "authorization")).toBeNull();
    expect(header(calls[0], "if-none-match")).toBe('"e1"');
  });

  it("resolves the default branch once when no branch is configured", async () => {
    const { fetch, calls } = fakeFetch({
      [REPO]: json({ default_branch: "trunk" }),
      [`${REPO}/git/ref/heads/trunk`]: json({ object: { sha: "c1" } }, { etag: '"e1"' }),
    });
    const github = source(fetch, { branch: null });
    await github.head(null);
    await github.head(null);
    expect(calls.map((call) => call.url)).toEqual([
      REPO,
      `${REPO}/git/ref/heads/trunk`,
      `${REPO}/git/ref/heads/trunk`,
    ]);
  });

  it("encodes each segment of a branch name with slashes", async () => {
    const { fetch, calls } = fakeFetch({
      [`${REPO}/git/ref/heads/team/v%231`]: json({ object: { sha: "c1" } }),
    });
    await source(fetch, { branch: "team/v#1" }).head(null);
    expect(calls[0]?.url).toBe(`${REPO}/git/ref/heads/team/v%231`);
  });
});

describe("GitHubSource.listDirectory", () => {
  const routes = () => ({
    [`${REPO}/git/commits/c1`]: json({ sha: "c1", tree: { sha: "t-root" } }),
    [`${REPO}/git/trees/t-root`]: tree([
      { path: ".agent-collab", type: "blob", sha: "b-marker" },
      { path: "inbox", type: "tree", sha: "t-inbox" },
      { path: "vendor", type: "commit", sha: "s1", mode: "160000" },
      { path: "link", type: "blob", sha: "b-link", mode: "120000" },
    ]),
    [`${REPO}/git/trees/t-inbox`]: tree([{ path: "2026-10", type: "tree", sha: "t-oct" }]),
    [`${REPO}/git/trees/t-oct`]: tree([{ path: "a.md", type: "blob", sha: "b-a" }]),
  });

  it("lists the root of a revision, skipping submodules and symlinks", async () => {
    const { fetch } = fakeFetch(routes());
    expect(await source(fetch).listDirectory("c1", "")).toEqual([
      { name: ".agent-collab", path: ".agent-collab", kind: "file", objectId: "b-marker" },
      { name: "inbox", path: "inbox", kind: "directory", objectId: "t-inbox" },
    ]);
  });

  it("walks nested directories and caches immutable objects", async () => {
    const { fetch, calls } = fakeFetch(routes());
    const github = source(fetch);
    const first = await github.listDirectory("c1", "inbox/2026-10");
    const second = await github.listDirectory("c1", "inbox/2026-10");
    expect(first).toEqual([
      { name: "a.md", path: "inbox/2026-10/a.md", kind: "file", objectId: "b-a" },
    ]);
    expect(second).toEqual(first);
    expect(calls.map((call) => call.url.slice(REPO.length))).toEqual([
      "/git/commits/c1",
      "/git/trees/t-root",
      "/git/trees/t-inbox",
      "/git/trees/t-oct",
    ]);
  });

  it("reports a missing path as not-found", async () => {
    const { fetch } = fakeFetch(routes());
    await expect(source(fetch).listDirectory("c1", "topics")).rejects.toMatchObject({
      kind: "not-found",
      path: "topics",
    });
  });

  it("refuses a truncated listing instead of returning partial history", async () => {
    const { fetch } = fakeFetch({
      [`${REPO}/git/commits/c1`]: json({ tree: { sha: "t-root" } }),
      [`${REPO}/git/trees/t-root`]: tree([], true),
    });
    await expect(source(fetch).listDirectory("c1", "")).rejects.toMatchObject({
      kind: "too-large",
    });
  });
});

describe("GitHubSource.readFile", () => {
  it("downloads a blob as raw text once", async () => {
    const { fetch, calls } = fakeFetch({ [`${REPO}/git/blobs/b-a`]: raw("hello") });
    const github = source(fetch);
    const entry = { name: "a.md", path: "inbox/a.md", kind: "file", objectId: "b-a" } as const;
    expect(await github.readFile(entry)).toBe("hello");
    expect(await github.readFile(entry)).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(header(calls[0], "accept")).toBe("application/vnd.github.raw+json");
  });
});

describe("GitHubSource rate limits and errors", () => {
  const url = `${REPO}/git/ref/heads/main`;

  async function failure(reply: Reply): Promise<SourceError> {
    const { fetch } = fakeFetch({ [url]: reply });
    const error: unknown = await source(fetch)
      .head(null)
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    if (!(error instanceof SourceError))
      throw new Error(`expected SourceError, got ${String(error)}`);
    return error;
  }

  it("exposes the rate limit from the latest response", async () => {
    const { fetch } = fakeFetch({ [url]: json({ object: { sha: "c1" } }) });
    const github = source(fetch);
    expect(github.rateLimit()).toBeNull();
    await github.head(null);
    expect(github.rateLimit()).toEqual({
      limit: 5000,
      remaining: 4990,
      resetAt: new Date(1793600000 * 1000),
    });
  });

  it("maps an exhausted primary limit to rate-limited until the reset", async () => {
    const error = await failure(status(403, { "x-ratelimit-remaining": "0" }));
    expect(error).toMatchObject({ kind: "rate-limited", status: 403 });
    expect(error.retryAt).toEqual(new Date(1793600000 * 1000));
  });

  it("maps a secondary limit with retry-after to rate-limited", async () => {
    const error = await failure(status(429, { "retry-after": "60" }));
    expect(error).toMatchObject({ kind: "rate-limited", status: 429 });
    expect(error.retryAt).toEqual(new Date("2026-11-02T00:01:00Z"));
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not-found"],
    [500, "unexpected"],
  ] as const)("maps HTTP %i to %s", async (code, kind) => {
    expect(await failure(status(code))).toMatchObject({ kind, status: code });
  });

  it("explains that an anonymous repository needs a token or does not exist", async () => {
    for (const code of [401, 404]) {
      const { fetch, calls } = fakeFetch({ [url]: status(code) });
      await expect(source(fetch, { token: null }).head(null)).rejects.toMatchObject({
        message: "This repository needs a token or does not exist.",
      });
      expect(header(calls[0], "authorization")).toBeNull();
    }
  });

  it("explains access denial and includes the rate-limit reset time", async () => {
    const forbiddenFetch = fakeFetch({ [url]: status(403) });
    const forbiddenRequest = source(forbiddenFetch.fetch, { token: null }).head(null);
    await expect(forbiddenRequest).rejects.toMatchObject({
      message: "Access was denied. Check that the repository is public.",
    });
    expect(header(forbiddenFetch.calls[0], "authorization")).toBeNull();

    const rateFetch = fakeFetch({ [url]: status(403, { "x-ratelimit-remaining": "0" }) });
    const rateRequest = source(rateFetch.fetch, { token: null }).head(null);
    await expect(rateRequest).rejects.toThrow(/GitHub API rate limit reached.*2026/);
    expect(header(rateFetch.calls[0], "authorization")).toBeNull();
  });

  it("maps a network failure to unreachable", async () => {
    expect(await failure(new TypeError("Failed to fetch"))).toMatchObject({
      kind: "unreachable",
      status: null,
    });
  });

  it("maps an unparseable success body to unexpected", async () => {
    expect(await failure(new Response("<html>", { status: 200 }))).toMatchObject({
      kind: "unexpected",
    });
  });

  it("never exposes the token in errors or serialized state", async () => {
    const error = await failure(status(401));
    const github = source(fakeFetch({}).fetch);
    for (const text of [
      error.message,
      String(error),
      JSON.stringify(error),
      inspect(error),
      JSON.stringify(github),
      inspect(github, { depth: 5 }),
    ]) {
      expect(text).not.toContain(TOKEN);
    }
  });
});

describe("GitHubSource with the loader", () => {
  it("loads a monthly repository end to end through the interface", async () => {
    const id = "2026-10-01T0900-bob-agent-api-01";
    const { fetch } = fakeFetch({
      [`${REPO}/git/ref/heads/main`]: json({ object: { sha: "c1" } }, { etag: '"e1"' }),
      [`${REPO}/git/commits/c1`]: json({ tree: { sha: "t-root" } }),
      [`${REPO}/git/trees/t-root`]: tree([
        { path: ".agent-collab", type: "blob", sha: "b-marker" },
        { path: "inbox", type: "tree", sha: "t-inbox" },
      ]),
      [`${REPO}/git/trees/t-inbox`]: tree([{ path: "2026-10", type: "tree", sha: "t-oct" }]),
      [`${REPO}/git/trees/t-oct`]: tree([{ path: `${id}.md`, type: "blob", sha: "b-msg" }]),
      [`${REPO}/git/blobs/b-marker`]: raw("collab-protocol: 1\ninbox-layout: monthly\n"),
      [`${REPO}/git/blobs/b-msg`]: raw(messageText(id, "bob-agent", "api")),
    });
    const loader = new Loader(source(fetch));
    await loader.open();
    const items = loader.getSnapshot().items;
    expect(items.map((item) => (item.kind === "message" ? item.message.id : item.kind))).toEqual([
      id,
    ]);
  });
});

describe("GitHubSource attachments", () => {
  it("carries the blob size of a listed file", async () => {
    const { fetch } = fakeFetch({
      [`${REPO}/git/commits/c1`]: json({ tree: { sha: "t-root" } }),
      [`${REPO}/git/trees/t-root`]: json({
        truncated: false,
        tree: [{ path: "data.csv", type: "blob", mode: "100644", sha: "b-1", size: 42 }],
      }),
    });
    expect(await source(fetch).listDirectory("c1", "")).toEqual([
      { name: "data.csv", path: "data.csv", kind: "file", objectId: "b-1", size: 42 },
    ]);
  });

  it("links a file to the repository's web page, for github.com and an enterprise host", () => {
    const { fetch } = fakeFetch({});
    expect(
      source(fetch, { apiBase: "https://api.github.com", branch: "feature/x y" }).webLink(
        "topics/a b/c.md",
      ),
    ).toEqual({
      url: "https://github.com/alice-org/collab/blob/feature/x%20y/topics/a%20b/c.md",
      label: "GitHub",
    });
    expect(
      source(fetch, { apiBase: "https://git.example.com/api/v3", branch: null }).webLink(
        "topics/c.md",
      ),
    ).toEqual({
      url: "https://git.example.com/alice-org/collab/blob/HEAD/topics/c.md",
      label: "GitHub",
    });
  });
});

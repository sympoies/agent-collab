import { describe, expect, it, vi } from "vitest";

import { DemoFallbackSource } from "../src/source/demo-fallback";
import { FixtureSource } from "../src/source/fixture";
import { GitHubSource } from "../src/source/github";
import { Loader } from "../src/loader/loader";
import { DemoSnapshotSource } from "../src/settings/demo-snapshot";
import { SourceError, type MessageSource } from "../src/source/types";

const fallbackFiles = { ".agent-collab": "collab-protocol: 1\n" };

describe("DemoFallbackSource", () => {
  it("switches to the fallback and reports the reset time on a rate-limit error", async () => {
    const resetAt = new Date("2026-11-03T12:00:00.000Z");
    const live = new FixtureSource({});
    const head = vi
      .spyOn(live, "head")
      .mockRejectedValue(new SourceError("rate-limited", "", 403, resetAt));
    const fallback = new FixtureSource(fallbackFiles);
    const onFallback = vi.fn();
    const source = new DemoFallbackSource(live, fallback, onFallback);

    await expect(source.head(null)).resolves.toMatchObject({ revision: "r1" });
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ retryAt: resetAt }));
    await expect(source.listDirectory("ignored-api-revision", "")).resolves.toHaveLength(1);
    expect(head).toHaveBeenCalledOnce();
  });

  it("switches to fallback content when the provider reports no remaining calls", async () => {
    const resetAt = new Date("2026-11-03T12:00:00.000Z");
    const live = new FixtureSource({});
    const limitedSource: MessageSource = {
      head: () => Promise.resolve({ revision: "api-revision", validator: null }),
      listDirectory: live.listDirectory.bind(live),
      readFile: live.readFile.bind(live),
      rateLimit: () => ({ limit: 60, remaining: 0, resetAt }),
    };
    const fallback = new FixtureSource(fallbackFiles);
    const onFallback = vi.fn();
    const source = new DemoFallbackSource(limitedSource, fallback, onFallback);
    await expect(source.head(null)).resolves.toMatchObject({ revision: "r1" });
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ retryAt: resetAt }));
  });

  it("opens the static snapshot after the GitHub API returns a rate-limit response", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    const live = new GitHubSource({
      apiBase: "https://api.github.com",
      owner: "sample-owner",
      repo: "sample-repository",
      branch: null,
      token: null,
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "rate limited" }), {
            status: 403,
            headers: {
              "x-ratelimit-limit": "60",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetAt),
            },
          }),
        ),
      ),
    });
    const snapshot = new DemoSnapshotSource({
      schemaVersion: 1,
      generatedAt: "2026-11-03T08:00:00.000Z",
      revision: "snapshot-tree",
      files: [{ path: ".agent-collab", text: "collab-protocol: 1\n" }],
    });
    const fallback = vi.fn();
    const loader = new Loader(new DemoFallbackSource(live, snapshot, fallback));
    await expect(loader.open()).resolves.toBeUndefined();
    expect(loader.getSnapshot().rosterKnown).toBe(true);
    expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ kind: "rate-limited" }));
  });
});

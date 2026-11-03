import { describe, expect, it, vi } from "vitest";

import { checkLive, LiveCheckGate, openLiveDemo } from "../src/settings/live-demo";
import { FixtureSource } from "../src/source/fixture";
import { SourceError } from "../src/source/types";
import { flat, repo } from "./support";

const MINUTE = 60_000;

function clock(start = Date.UTC(2026, 10, 3, 9)) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function rateLimitedSource(retryAt: Date | null): FixtureSource {
  const source = new FixtureSource({});
  vi.spyOn(source, "head").mockRejectedValue(new SourceError("rate-limited", "", 403, retryAt));
  return source;
}

describe("LiveCheckGate", () => {
  it("spaces requests by the poll interval after any request", () => {
    const time = clock();
    const gate = new LiveCheckGate(time.now);
    expect(gate.nextCheckAt()).toBeNull();
    gate.record(null);
    expect(gate.nextCheckAt()?.getTime()).toBe(time.now() + 5 * MINUTE);
    time.advance(5 * MINUTE);
    expect(gate.nextCheckAt()).toBeNull();
  });

  it("waits for the reported reset time after a rate limit, and for the longest backoff without one", () => {
    const time = clock();
    const gate = new LiveCheckGate(time.now);
    const resetAt = new Date(time.now() + 40 * MINUTE);
    gate.record(new SourceError("rate-limited", "", 403, resetAt));
    expect(gate.nextCheckAt()).toEqual(resetAt);

    gate.record(new SourceError("rate-limited", "", 403, null));
    expect(gate.nextCheckAt()?.getTime()).toBe(time.now() + 15 * MINUTE);
  });
});

describe("checkLive", () => {
  const view = { kind: "snapshot", generatedAt: "2026-11-03T08:00:00.000Z" } as const;

  it("keeps the static copy on a rate limit, makes no request while blocked, and recovers after the reset", async () => {
    const time = clock();
    const gate = new LiveCheckGate(time.now);
    const resetAt = new Date(time.now() + 30 * MINUTE);
    const live = new FixtureSource(repo([flat("2026-11", 3, 1)]));
    const createSource = vi
      .fn<() => FixtureSource>()
      .mockReturnValueOnce(rateLimitedSource(resetAt))
      .mockReturnValue(live);

    const limited = await checkLive(createSource, view, gate);
    expect(limited.loader).toBeNull();
    expect(limited.notice).toContain("hit GitHub's API limit");
    expect(limited.notice).toContain("2026-11-03T08:00:00.000Z");

    time.advance(10 * MINUTE);
    const paused = await checkLive(createSource, view, gate);
    expect(paused.loader).toBeNull();
    expect(paused.notice).toContain("paused");
    expect(createSource).toHaveBeenCalledOnce();

    time.advance(20 * MINUTE);
    const recovered = await checkLive(createSource, view, gate);
    expect(createSource).toHaveBeenCalledTimes(2);
    expect(recovered.loader?.getSnapshot().items).toHaveLength(1);
  });
});

describe("openLiveDemo without a snapshot", () => {
  it("shows the bundled sample without a request while the gate is closed", async () => {
    const gate = new LiveCheckGate();
    gate.record(new SourceError("rate-limited", "", 403, new Date(Date.now() + 30 * MINUTE)));
    const createSource = vi.fn(() => new FixtureSource({}));
    const opened = await openLiveDemo(createSource, repo([flat("2026-11", 3, 1)]), gate, () =>
      Promise.resolve(null),
    );
    expect(createSource).not.toHaveBeenCalled();
    expect(opened.view).toEqual({ kind: "bundled" });
    expect(opened.banner).toContain("paused");
    expect(opened.loader.getSnapshot().items).toHaveLength(1);
  });

  it("shows the live repository when the API answers and the snapshot is missing", async () => {
    const opened = await openLiveDemo(
      () => new FixtureSource(repo([flat("2026-11", 3, 1)])),
      {},
      new LiveCheckGate(),
      () => Promise.resolve(null),
    );
    expect(opened.view).toEqual({ kind: "live" });
  });
});

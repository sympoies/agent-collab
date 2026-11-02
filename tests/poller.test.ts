import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SetupError } from "../src/loader/loader";
import { nextPollDelay, Poller, POLL } from "../src/loader/poller";
import { SourceError, type RateLimit } from "../src/source/types";

const NOW = new Date("2026-11-02T00:00:00Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const base = { visible: true, failures: 0, error: null, rateLimit: null, now: NOW } as const;

function limit(remaining: number, resetInMs: number): RateLimit {
  return { limit: 5000, remaining, resetAt: new Date(NOW.getTime() + resetInMs) };
}

describe("nextPollDelay", () => {
  it("polls every minute while visible and every five minutes while hidden", () => {
    expect(nextPollDelay(base)).toBe(POLL.visibleMs);
    expect(nextPollDelay({ ...base, visible: false })).toBe(POLL.hiddenMs);
    expect([POLL.visibleMs, POLL.hiddenMs]).toEqual([MINUTE, 5 * MINUTE]);
  });

  it("backs off exponentially after failures, capped at fifteen minutes", () => {
    const error = new SourceError("unreachable", "");
    expect(nextPollDelay({ ...base, failures: 1, error })).toBe(2 * MINUTE);
    expect(nextPollDelay({ ...base, failures: 3, error })).toBe(8 * MINUTE);
    expect(nextPollDelay({ ...base, failures: 10, error })).toBe(15 * MINUTE);
  });

  it("waits until retryAt when rate limited", () => {
    const error = new SourceError("rate-limited", "", 403, new Date(NOW.getTime() + 20 * MINUTE));
    expect(nextPollDelay({ ...base, failures: 1, error })).toBe(20 * MINUTE);
  });

  it("stops polling on errors that need the user", () => {
    for (const kind of ["unauthorized", "forbidden", "not-found"] as const) {
      expect(nextPollDelay({ ...base, failures: 1, error: new SourceError(kind, "") })).toBeNull();
    }
    expect(nextPollDelay({ ...base, failures: 1, error: new SetupError("no marker") })).toBeNull();
  });

  it("stretches the interval when less than ten percent of the budget remains", () => {
    expect(nextPollDelay({ ...base, rateLimit: limit(20, 50 * MINUTE) })).toBe(2.5 * MINUTE);
    expect(nextPollDelay({ ...base, rateLimit: limit(10, 50 * MINUTE) })).toBe(5 * MINUTE);
    expect(nextPollDelay({ ...base, rateLimit: limit(4000, 50 * MINUTE) })).toBe(MINUTE);
  });
});

describe("Poller", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls on schedule and stops when asked", async () => {
    const tick = vi.fn(() => Promise.resolve());
    const poller = new Poller(tick, { visible: () => true, rateLimit: () => null });
    poller.start();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(tick).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("reports an error that needs the user and stops", async () => {
    const error = new SourceError("unauthorized", "", 401);
    const tick = vi.fn(() => Promise.reject(error));
    const onError = vi.fn();
    const poller = new Poller(tick, { visible: () => true, rateLimit: () => null, onError });
    poller.start();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("backs off after a transient error and recovers", async () => {
    const tick = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new SourceError("unreachable", ""))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const poller = new Poller(tick, { visible: () => true, rateLimit: () => null, onError });
    poller.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * MINUTE - 1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(null);
  });
});

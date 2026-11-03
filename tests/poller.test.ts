import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SetupError } from "../src/loader/loader";
import { nextPollDelay, Poller, POLL } from "../src/loader/poller";
import { SourceError, type RateLimit } from "../src/source/types";

const NOW = new Date("2026-11-02T00:00:00Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const base = {
  visible: true,
  failures: 0,
  error: null,
  succeeded: false,
  rateLimit: null,
  now: NOW,
} as const;

function limit(remaining: number, resetInMs: number): RateLimit {
  return { limit: 5000, remaining, resetAt: new Date(NOW.getTime() + resetInMs) };
}

describe("nextPollDelay", () => {
  it("polls every minute while visible and every five minutes while hidden", () => {
    expect(nextPollDelay(base)).toBe(POLL.visibleMs);
    expect(nextPollDelay({ ...base, visible: false })).toBe(POLL.hiddenMs);
    expect([POLL.visibleMs, POLL.hiddenMs]).toEqual([MINUTE, 5 * MINUTE]);
  });

  it("uses a five-minute visible interval for anonymous sessions", () => {
    expect(nextPollDelay({ ...base, visibleIntervalMs: 5 * MINUTE })).toBe(5 * MINUTE);
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
    expect(
      nextPollDelay({ ...base, failures: 1, error: new SetupError("no marker", "no-marker") }),
    ).toBeNull();
  });

  it("backs off on forbidden once a request has succeeded", () => {
    const error = new SourceError("forbidden", "", 403);
    expect(nextPollDelay({ ...base, failures: 1, error, succeeded: true })).toBe(2 * MINUTE);
    expect(nextPollDelay({ ...base, failures: 1, error, succeeded: false })).toBeNull();
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

  it("waits five minutes before polling an anonymous session", async () => {
    const tick = vi.fn(() => Promise.resolve());
    const poller = new Poller(tick, {
      visible: () => true,
      visibleIntervalMs: 5 * MINUTE,
      rateLimit: () => null,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledOnce();
    poller.stop();
  });

  it("reschedules after a manual refresh hits the rate limit", async () => {
    const retryAt = new Date(NOW.getTime() + 20 * MINUTE);
    const tick = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new SourceError("rate-limited", "", 403, retryAt))
      .mockResolvedValue(undefined);
    const poller = new Poller(tick, {
      visible: () => true,
      visibleIntervalMs: 5 * MINUTE,
      rateLimit: () => null,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await poller.refreshNow();
    expect(tick).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(tick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(tick).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("allows a manual refresh to recover after a stopping open error", async () => {
    const tick = vi.fn(() => Promise.resolve());
    const poller = new Poller(tick, { visible: () => true, rateLimit: () => null });
    poller.start(() => Promise.reject(new SourceError("unauthorized", "", 401)));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(tick).not.toHaveBeenCalled();

    await poller.refreshNow();
    expect(tick).toHaveBeenCalledOnce();
    poller.stop();
  });

  it("does not add a manual request before the anonymous poll interval", async () => {
    const tick = vi.fn(() => Promise.resolve());
    const poller = new Poller(tick, {
      visible: () => true,
      visibleIntervalMs: 5 * MINUTE,
      rateLimit: () => null,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await poller.refreshNow(5 * MINUTE)).toBe(false);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(tick).toHaveBeenCalledOnce();
    poller.stop();
  });

  it("retires a pending Load older retry after a manual recovery", async () => {
    const retryAt = new Date(NOW.getTime() + MINUTE);
    const loadOlder = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new SourceError("rate-limited", "", 403, retryAt))
      .mockResolvedValue(undefined);
    const tick = vi.fn(() => Promise.resolve());
    const poller = new Poller(tick, {
      visible: () => true,
      visibleIntervalMs: 5 * MINUTE,
      rateLimit: () => null,
    });
    const firstAction = () => loadOlder();
    const manualAction = () => loadOlder();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await poller.runOperation(firstAction, 0, "load-older");
    await vi.advanceTimersByTimeAsync(MINUTE);
    await poller.runOperation(manualAction, 0, "load-older");
    expect(loadOlder).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(loadOlder).toHaveBeenCalledTimes(2);
    expect(tick).toHaveBeenCalledOnce();
    poller.stop();
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

  it("does not poll when opening fails with an error that needs the user", async () => {
    const error = new SetupError("no marker", "no-marker");
    const tick = vi.fn(() => Promise.resolve());
    const onError = vi.fn();
    const poller = new Poller(tick, { visible: () => true, rateLimit: () => null, onError });
    poller.start(() => Promise.reject(error));
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(tick).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("waits until retryAt when opening is rate limited", async () => {
    const error = new SourceError("rate-limited", "", 403, new Date(NOW.getTime() + 20 * MINUTE));
    const tick = vi.fn(() => Promise.resolve());
    const first = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const poller = new Poller(tick, { visible: () => true, rateLimit: () => null });
    poller.start(first);
    await vi.advanceTimersByTimeAsync(20 * MINUTE - 1);
    expect(first).toHaveBeenCalledOnce();
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(first).toHaveBeenCalledTimes(2);
    expect(tick).not.toHaveBeenCalled();
  });

  it("keeps polling with backoff after a forbidden poll that follows a success", async () => {
    const tick = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new SourceError("forbidden", "", 403))
      .mockResolvedValue(undefined);
    const poller = new Poller(tick, { visible: () => true, rateLimit: () => null });
    poller.start(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("polls at once when the page becomes visible after the visible interval", async () => {
    let visible = false;
    const tick = vi.fn(() => Promise.resolve());
    const poller = new Poller(tick, { visible: () => visible, rateLimit: () => null });
    poller.start();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(tick).not.toHaveBeenCalled();
    visible = true;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});

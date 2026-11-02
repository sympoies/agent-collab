// Polling schedule (docs/design.md, section 7): conditional polls on an interval,
// exponential backoff on errors, and rate-limit awareness. No server push.

import { SourceError, type RateLimit } from "../source/types";
import { SetupError } from "./loader";

export const POLL = {
  visibleMs: 60_000,
  hiddenMs: 300_000,
  maxBackoffMs: 900_000,
  /** Stretch the interval when less than this share of the budget remains. */
  lowBudgetShare: 0.1,
} as const;

/** Source errors that polling cannot fix; the user has to change settings. */
const STOPPING_ERRORS = new Set(["unauthorized", "forbidden", "not-found"]);
/** Stopping errors that are retried with backoff once a request has succeeded. */
const TRANSIENT_AFTER_SUCCESS = new Set(["forbidden"]);

export interface PollState {
  readonly visible: boolean;
  /** Anonymous sessions can request a longer visible interval. */
  readonly visibleIntervalMs?: number;
  /** Consecutive failed polls. */
  readonly failures: number;
  /** Error of the last poll, or null if it succeeded. */
  readonly error: unknown;
  /** A request (open or poll) has succeeded before. */
  readonly succeeded: boolean;
  readonly rateLimit: RateLimit | null;
  readonly now: Date;
}

/** Milliseconds until the next poll, or null to stop polling. */
export function nextPollDelay(state: PollState): number | null {
  const base = state.visible ? (state.visibleIntervalMs ?? POLL.visibleMs) : POLL.hiddenMs;
  const { error } = state;
  if (error instanceof SetupError) return null;
  if (
    error instanceof SourceError &&
    STOPPING_ERRORS.has(error.kind) &&
    !(state.succeeded && TRANSIENT_AFTER_SUCCESS.has(error.kind))
  ) {
    return null;
  }
  if (error instanceof SourceError && error.kind === "rate-limited" && error.retryAt !== null) {
    return Math.max(base, error.retryAt.getTime() - state.now.getTime());
  }
  if (state.failures > 0) {
    return Math.min(POLL.maxBackoffMs, base * 2 ** state.failures);
  }
  const budget = state.rateLimit;
  if (budget !== null && budget.remaining < budget.limit * POLL.lowBudgetShare) {
    const untilReset = budget.resetAt.getTime() - state.now.getTime();
    return Math.max(base, Math.ceil(untilReset / Math.max(budget.remaining, 1)));
  }
  return base;
}

export interface PollerEnvironment {
  readonly visible: () => boolean;
  readonly visibleIntervalMs?: number;
  readonly rateLimit: () => RateLimit | null;
  /** Called after each poll with its error, or null when it succeeded. */
  readonly onError?: (error: unknown) => void;
}

export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private succeeded = false;
  private running = false;
  private inFlight = false;
  private lastError: unknown = null;
  private lastRunAt = 0;

  constructor(
    private readonly tick: () => Promise<unknown>,
    private readonly env: PollerEnvironment,
  ) {}

  /**
   * Runs `first` (usually opening the source) and schedules the polls from
   * its outcome, so an open error stops polling or delays it like a poll error.
   */
  start(first: () => Promise<unknown> = () => Promise.resolve()): void {
    if (this.running) return;
    this.running = true;
    void this.run(first);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs a user-requested refresh through the same error and scheduling path. */
  refreshNow(): Promise<void> {
    if (!this.running || this.inFlight) return Promise.resolve();
    if (
      this.lastError instanceof SourceError &&
      this.lastError.kind === "rate-limited" &&
      this.lastError.retryAt !== null &&
      this.lastError.retryAt.getTime() > Date.now()
    ) {
      return Promise.resolve();
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    return this.run(this.tick);
  }

  /** Reschedules for the current visibility; a page that became visible polls at once if due. */
  visibilityChanged(): void {
    if (!this.running || this.inFlight) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule();
  }

  private schedule(): void {
    if (!this.running) return;
    // Delays count from the end of the last run, so a reschedule keeps its place.
    const delay = nextPollDelay({
      visible: this.env.visible(),
      ...(this.env.visibleIntervalMs === undefined
        ? {}
        : { visibleIntervalMs: this.env.visibleIntervalMs }),
      failures: this.failures,
      error: this.lastError,
      succeeded: this.succeeded,
      rateLimit: this.env.rateLimit(),
      now: new Date(this.lastRunAt),
    });
    if (delay === null) {
      this.stop();
      return;
    }
    this.timer = setTimeout(
      () => {
        void this.run(this.tick);
      },
      Math.max(0, this.lastRunAt + delay - Date.now()),
    );
  }

  private async run(operation: () => Promise<unknown>): Promise<void> {
    this.timer = null;
    this.inFlight = true;
    let error: unknown = null;
    try {
      await operation();
      this.failures = 0;
      this.succeeded = true;
    } catch (caught) {
      error = caught;
      this.failures += 1;
    }
    this.inFlight = false;
    if (!this.running) return;
    this.lastError = error;
    this.lastRunAt = Date.now();
    this.env.onError?.(error);
    this.schedule();
  }
}

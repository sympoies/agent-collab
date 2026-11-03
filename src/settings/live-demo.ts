import type { MessageSource } from "../source/types";
import { SourceError } from "../source/types";
import { Loader } from "../loader/loader";
import { POLL } from "../loader/poller";
import { FixtureSource } from "../source/fixture";
import { DemoSnapshotSource, readDemoSnapshot, type DemoSnapshot } from "./demo-snapshot";

/** Anonymous sessions poll every five minutes, regardless of page visibility. */
export const LIVE_DEMO_POLL_INTERVAL_MS = 5 * 60_000;

/** A static copy of the demo that makes no API requests. */
export type StaticDemoView =
  { readonly kind: "snapshot"; readonly generatedAt: string } | { readonly kind: "bundled" };

/** The one copy of the demo a viewer shows; a viewer never mixes two copies. */
export type LiveDemoView = StaticDemoView | { readonly kind: "live" };

/**
 * Spaces the anonymous API requests of one page session: every request blocks
 * the next for at least the poll interval, and a rate-limit response blocks it
 * until the reset time the API reported (or the longest backoff when it
 * reported none). Opening or navigating never resets it.
 */
export class LiveCheckGate {
  private blockedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** When the next API request may be made, or null when one is allowed now. */
  nextCheckAt(): Date | null {
    return this.blockedUntil > this.now() ? new Date(this.blockedUntil) : null;
  }

  /** Records a request that just finished; `error` is its failure, or null for success. */
  record(error: unknown): void {
    const now = this.now();
    let wait = LIVE_DEMO_POLL_INTERVAL_MS;
    if (error instanceof SourceError && error.kind === "rate-limited") {
      wait =
        error.retryAt === null ? POLL.maxBackoffMs : Math.max(wait, error.retryAt.getTime() - now);
    }
    this.blockedUntil = now + wait;
  }
}

function shown(view: StaticDemoView): string {
  return view.kind === "snapshot"
    ? `the snapshot generated at ${view.generatedAt}`
    : "the bundled sample";
}

/** Says why a live check left the viewer on its static copy; `error` null means it was not made. */
export function liveCheckNotice(
  view: StaticDemoView,
  error: unknown,
  nextCheckAt: Date | null,
): string {
  const reason =
    error === null
      ? "The live check is paused to respect GitHub's API limit"
      : error instanceof SourceError && error.kind === "rate-limited"
        ? "The live check hit GitHub's API limit"
        : "The live check is unavailable";
  const next = nextCheckAt === null ? "" : ` Next live check: ${nextCheckAt.toLocaleString()}.`;
  return `${reason}. Still showing ${shown(view)}.${next}`;
}

/**
 * Reads the live repository completely or not at all, so its data never mixes with another copy.
 * Complete means the open succeeded and no file of the loaded page is unavailable; a copy that
 * lacks one message never replaces a copy that has it. The gate closes when the request starts,
 * so a second open or check cannot run in parallel.
 */
async function openLive(
  createSource: () => MessageSource,
  gate: LiveCheckGate,
): Promise<{ readonly loader: Loader } | { readonly error: unknown }> {
  gate.record(null);
  const loader = new Loader(createSource());
  try {
    await loader.open();
    if (loader.getSnapshot().items.some((item) => item.kind === "unavailable")) {
      throw new SourceError("unexpected", "", null, null, "The live copy is incomplete.");
    }
    return { loader };
  } catch (error) {
    gate.record(error);
    return { error };
  }
}

export interface LiveCheck {
  /** The complete live copy, or null when the static copy stays. */
  readonly loader: Loader | null;
  readonly notice: string;
}

/**
 * The user asked for live data while a static copy is on screen. Success
 * replaces the copy; a failure or a closed gate leaves it untouched.
 */
export async function checkLive(
  createSource: () => MessageSource,
  view: StaticDemoView,
  gate: LiveCheckGate,
): Promise<LiveCheck> {
  const blockedUntil = gate.nextCheckAt();
  if (blockedUntil !== null) {
    return { loader: null, notice: liveCheckNotice(view, null, blockedUntil) };
  }
  const result = await openLive(createSource, gate);
  if ("loader" in result) return { loader: result.loader, notice: "Checked the live repository." };
  return { loader: null, notice: liveCheckNotice(view, result.error, gate.nextCheckAt()) };
}

/** Opens a viewer source without settings or credential-store access. */
export interface LiveDemoOpen {
  readonly loader: Loader;
  readonly view: LiveDemoView;
  readonly banner: string;
}

/**
 * Opens the snapshot first, which needs no API request. Only without a usable
 * snapshot does it ask the API, and only when the gate allows; the bundled
 * sample is the last resort.
 */
export async function openLiveDemo(
  createSource: () => MessageSource,
  bundledFiles: Readonly<Record<string, string>>,
  gate: LiveCheckGate,
  loadSnapshot: () => Promise<DemoSnapshot | null> = () => readDemoSnapshot(),
): Promise<LiveDemoOpen> {
  const snapshot = await loadSnapshot();
  if (snapshot !== null) {
    const loader = new Loader(new DemoSnapshotSource(snapshot));
    try {
      await loader.open();
      return {
        loader,
        view: { kind: "snapshot", generatedAt: snapshot.generatedAt },
        banner: `Showing the snapshot generated at ${snapshot.generatedAt}.`,
      };
    } catch {
      // A malformed snapshot is treated as missing and uses the same fallback order below.
    }
  }

  const bundled: StaticDemoView = { kind: "bundled" };
  const blockedUntil = gate.nextCheckAt();
  let banner = liveCheckNotice(bundled, null, blockedUntil);
  if (blockedUntil === null) {
    const result = await openLive(createSource, gate);
    if ("loader" in result) {
      return {
        loader: result.loader,
        view: { kind: "live" },
        banner: "The public snapshot is unavailable. Showing the live repository.",
      };
    }
    banner = liveCheckNotice(bundled, result.error, gate.nextCheckAt());
  }
  const loader = new Loader(new FixtureSource(bundledFiles));
  await loader.open();
  return { loader, view: bundled, banner };
}

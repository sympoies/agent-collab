import type { MessageSource } from "../source/types";
import { SourceError } from "../source/types";
import { Loader } from "../loader/loader";
import { FixtureSource } from "../source/fixture";
import { DemoSnapshotSource, readDemoSnapshot, type DemoSnapshot } from "./demo-snapshot";

/** Anonymous sessions poll every five minutes, regardless of page visibility. */
export const LIVE_DEMO_POLL_INTERVAL_MS = 5 * 60_000;

/** Opens a source without settings or credential-store access. */
export interface LiveDemoOpen {
  readonly loader: Loader;
  readonly fallbackSource: MessageSource;
  readonly generatedAt: string | null;
  readonly banner: string | null;
}

export async function openLiveDemo(
  createSource: () => MessageSource,
  bundledFiles: Readonly<Record<string, string>>,
  loadSnapshot: () => Promise<DemoSnapshot | null> = () => readDemoSnapshot(),
): Promise<LiveDemoOpen> {
  const snapshot = await loadSnapshot();
  if (snapshot !== null) {
    const source = new DemoSnapshotSource(snapshot);
    const loader = new Loader(source);
    try {
      await loader.open();
      return {
        loader,
        fallbackSource: source,
        generatedAt: snapshot.generatedAt,
        banner: `Showing the snapshot generated at ${snapshot.generatedAt}.`,
      };
    } catch {
      // A malformed snapshot is treated as missing and uses the same fallback order below.
    }
  }

  const apiSource = createSource();
  const apiLoader = new Loader(apiSource);
  try {
    await apiLoader.open();
    return {
      loader: apiLoader,
      fallbackSource: new FixtureSource(bundledFiles),
      generatedAt: null,
      banner: "The public snapshot is unavailable. Showing the live repository.",
    };
  } catch (error) {
    const fallbackSource = new FixtureSource(bundledFiles);
    const loader = new Loader(fallbackSource);
    await loader.open();
    const retryAt = error instanceof SourceError ? error.retryAt : null;
    return {
      loader,
      fallbackSource,
      generatedAt: null,
      banner:
        retryAt === null
          ? "The live demo is unavailable. Showing the bundled sample instead."
          : `GitHub's rate limit is reached. Reset at ${retryAt.toLocaleString()}. Showing the bundled sample instead.`,
    };
  }
}

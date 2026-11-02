import type { MessageSource } from "../source/types";

/** Anonymous sessions poll every five minutes, regardless of page visibility. */
export const LIVE_DEMO_POLL_INTERVAL_MS = 5 * 60_000;

/** Opens a source without settings or credential-store access. */
export function openLiveDemo(
  createSource: () => MessageSource,
  onOpen: (source: MessageSource) => void,
): void {
  onOpen(createSource());
}

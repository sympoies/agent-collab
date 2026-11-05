// Which kind of source the reader was last looking at, so a reload goes back to a GitHub
// repository only when that is what they had open. The demos never write it. Storage may be
// missing or throw; then nothing is reopened by itself.

import type { PreferenceStorage } from "../identity/preferences";

const KEY = "agent-collab-viewer.last-source";

export type LastSource = "github" | "other";

export function readLastSource(storage: Pick<PreferenceStorage, "getItem">): LastSource | null {
  try {
    const value = storage.getItem(KEY);
    return value === "github" || value === "other" ? value : null;
  } catch {
    return null;
  }
}

export function writeLastSource(storage: PreferenceStorage, source: LastSource): void {
  try {
    storage.setItem(KEY, source);
  } catch {
    // Nothing is remembered; the next reload starts on the welcome screen.
  }
}

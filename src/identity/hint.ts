// Whether the viewer dismissed the one-time "choose who you are" hint, per repository. Optional
// local state like the other identity preferences: storage may be missing or throw.

import type { PreferenceStorage } from "./preferences";

const KEY_PREFIX = "agent-collab-viewer.identity-hint:";

export function readHintDismissed(storage: PreferenceStorage | null, key: string): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(`${KEY_PREFIX}${key}`) === "1";
  } catch {
    return false;
  }
}

export function writeHintDismissed(storage: PreferenceStorage | null, key: string): void {
  if (storage === null) return;
  try {
    storage.setItem(`${KEY_PREFIX}${key}`, "1");
  } catch {
    // The hint is dismissed for this view only.
  }
}

// What this browser remembers for the viewer, and how to forget it. Everything the viewer keeps in
// browser storage starts with one prefix; the reader's language and theme are display preferences
// and stay.

import { LOCALE_KEY } from "../i18n/LocaleProvider";
import { THEME_KEY } from "../ui/ThemeProvider";

const PREFIX = "agent-collab-viewer.";
const KEEP: readonly string[] = [LOCALE_KEY, THEME_KEY];

/** The part of `Storage` this needs; a store that throws simply forgets nothing. */
export interface ForgettableStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/** Removes the saved repository, the identity and view choices and the like, keeping language and theme. */
export function forgetStored(storage: ForgettableStorage): void {
  try {
    // Collect first: removing while walking would skip keys.
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(PREFIX) && !KEEP.includes(key)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Blocked storage remembers nothing to forget.
  }
}

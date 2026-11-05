// The view a reader had open: chat, Questions or Files and, in the topic layout, the selected
// topic. Kept per source next to the identity choices so a reload returns to it. Only the view
// name and the topic name are stored, never message text. Storage may be missing or throw, in
// which case the view simply starts on All.

import { isTopicFolderName } from "../message/topic-layout";
import type { PreferenceStorage } from "./preferences";

const KEY_PREFIX = "agent-collab-viewer.view:";

export type ViewName = "chat" | "questions" | "files";

export interface ViewState {
  readonly view: ViewName;
  /** The selected topic, null for All. */
  readonly topic: string | null;
}

const DEFAULT_STATE: ViewState = { view: "chat", topic: null };

function sanitize(value: unknown): ViewState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_STATE;
  const { view, topic } = value as Record<string, unknown>;
  if (view !== "chat" && view !== "questions" && view !== "files") return DEFAULT_STATE;
  if (topic === null) return { view, topic: null };
  return typeof topic === "string" && isTopicFolderName(topic) ? { view, topic } : DEFAULT_STATE;
}

export function readViewState(storage: PreferenceStorage | null, key: string): ViewState {
  if (storage === null) return DEFAULT_STATE;
  try {
    const text = storage.getItem(`${KEY_PREFIX}${key}`);
    return text === null ? DEFAULT_STATE : sanitize(JSON.parse(text));
  } catch {
    return DEFAULT_STATE;
  }
}

/** Returns whether the state was saved; the view works from memory either way. */
export function writeViewState(
  storage: PreferenceStorage | null,
  key: string,
  state: ViewState,
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(`${KEY_PREFIX}${key}`, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

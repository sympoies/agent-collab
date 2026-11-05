// The view a reader had open: chat, Questions or Files and, in the topic layout, the selected
// topic. Kept per source next to the identity choices so a reload returns to it. Only the view
// name and the topic name are stored, never message text. Storage may be missing or throw, in
// which case the view simply starts on All. On a phone the state also says whether the view's
// screen was open, so a reload returns to it instead of the topic list.

import { parseFilter, type QuestionFilter } from "../message/question-filter";
import { isTopicFolderName } from "../message/topic-layout";
import type { PreferenceStorage } from "./preferences";

const KEY_PREFIX = "agent-collab-viewer.view:";

export type ViewName = "chat" | "questions" | "files";

export interface ViewState {
  readonly view: ViewName;
  /** The selected topic, null for All. */
  readonly topic: string | null;
  /** On a phone, the screen of the view is open rather than the topic list. */
  readonly conversation: boolean;
  /** The Questions node of the list: expanded or not, and the filter of the Questions page. */
  readonly questions?: QuestionsViewState;
}

export interface QuestionsViewState {
  readonly open: boolean;
  readonly filter: QuestionFilter | null;
}

export const DEFAULT_QUESTIONS: QuestionsViewState = { open: false, filter: null };

const DEFAULT_STATE: ViewState = { view: "chat", topic: null, conversation: false };

function sanitizeQuestions(value: unknown): QuestionsViewState {
  if (typeof value !== "object" || value === null) return DEFAULT_QUESTIONS;
  const { open, filter } = value as Record<string, unknown>;
  return { open: open === true, filter: parseFilter(filter) };
}

function sanitize(value: unknown): ViewState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_STATE;
  const { view, topic, conversation: open, questions: saved } = value as Record<string, unknown>;
  const conversation = open === true;
  const parsed = sanitizeQuestions(saved);
  // The Questions node is part of the state only when it differs from the default.
  const questions = parsed.open || parsed.filter !== null ? { questions: parsed } : {};
  if (view !== "chat" && view !== "questions" && view !== "files") return DEFAULT_STATE;
  if (topic === null) return { view, topic: null, conversation, ...questions };
  return typeof topic === "string" && isTopicFolderName(topic)
    ? { view, topic, conversation, ...questions }
    : DEFAULT_STATE;
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
    // The Questions node is written only when it differs from the default.
    const { questions, ...rest } = state;
    const set = questions !== undefined && (questions.open || questions.filter !== null);
    storage.setItem(`${KEY_PREFIX}${key}`, JSON.stringify(set ? { ...rest, questions } : rest));
    return true;
  } catch {
    return false;
  }
}

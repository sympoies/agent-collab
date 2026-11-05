import type { PreferenceStorage } from "../identity/preferences";

const QUESTION_EXPANSION_STORAGE_PREFIX = "agent-collab-viewer.questions.expanded";
const MAX_QUESTION_EXPANSION_CHOICES = 256;

export function questionExpansionStorageKey(repositoryKey: string): string {
  return `${QUESTION_EXPANSION_STORAGE_PREFIX}:${repositoryKey}`;
}

export type QuestionExpansionChoices = Readonly<Record<string, boolean>>;

export function readQuestionExpansionChoices(
  storage: PreferenceStorage | null,
  repositoryKey: string,
): QuestionExpansionChoices {
  if (storage === null) return {};
  try {
    const raw = storage.getItem(questionExpansionStorageKey(repositoryKey));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(validChoices(parsed).slice(-MAX_QUESTION_EXPANSION_CHOICES));
  } catch {
    return {};
  }
}

/** Update recency and keep both in-memory and persisted choices bounded. */
export function updateQuestionExpansionChoices(
  choices: QuestionExpansionChoices,
  id: string,
  expanded: boolean,
): QuestionExpansionChoices {
  const entries = Object.entries(choices).filter(([key]) => key !== id);
  entries.push([id, expanded]);
  return Object.fromEntries(entries.slice(-MAX_QUESTION_EXPANSION_CHOICES));
}

export function saveQuestionExpansionChoices(
  storage: PreferenceStorage | null,
  repositoryKey: string,
  choices: QuestionExpansionChoices,
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      questionExpansionStorageKey(repositoryKey),
      JSON.stringify(
        Object.fromEntries(validChoices(choices).slice(-MAX_QUESTION_EXPANSION_CHOICES)),
      ),
    );
  } catch {
    // In-memory App state keeps the choice for this session without storage.
  }
}

function validChoices(value: object): [string, boolean][] {
  return Object.entries(value).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
  );
}

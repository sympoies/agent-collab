// The filters of the Questions page that the left list offers (docs/design.md, section 5): the
// questions still open, the open ones a person has not answered, and the answered ones. The
// counts follow the question rules of deriveQuestionStates: a question addressed to several
// people is open for each recipient who has not answered; one every recipient answered, or that
// was concluded, is answered.

import type { QuestionGroups, QuestionItem } from "./receipts";

export type QuestionFilter =
  | { readonly kind: "open" }
  | { readonly kind: "answered" }
  | { readonly kind: "person"; readonly person: string };

export interface QuestionTree {
  readonly open: number;
  readonly answered: number;
  /** People with at least one open question they have not answered, most first. */
  readonly people: readonly { readonly name: string; readonly count: number }[];
}

/**
 * Who has not answered an open question: the recipients that can answer and have not, and a
 * named recipient the roster does not know (shown by its raw name).
 */
export function pendingPeople(item: QuestionItem, isKnown: (name: string) => boolean): string[] {
  const { state } = item;
  if (state.state !== "open") return [];
  const pending = state.eligibleAnswerers.filter((name) => !state.answerers.includes(name));
  const unknown = state.question.to.filter(
    (name) => name !== "all" && name !== state.question.from && !isKnown(name),
  );
  return [...new Set([...pending, ...unknown])];
}

export function questionTree(
  groups: QuestionGroups,
  isKnown: (name: string) => boolean,
): QuestionTree {
  const counts = new Map<string, number>();
  for (const item of groups.open) {
    for (const name of pendingPeople(item, isKnown)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return {
    open: groups.open.length,
    answered: groups.answered.length + groups.concluded.length,
    people: [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

/** Whether the filter still names something the tree offers; a gone person does not. */
export function filterIsCurrent(filter: QuestionFilter, tree: QuestionTree): boolean {
  return filter.kind !== "person" || tree.people.some((entry) => entry.name === filter.person);
}

export function applyFilter(
  groups: QuestionGroups,
  filter: QuestionFilter | null,
  isKnown: (name: string) => boolean,
): QuestionGroups {
  const none: readonly QuestionItem[] = [];
  if (filter === null) return groups;
  if (filter.kind === "open") {
    return { open: groups.open, concluded: none, answered: none, unknown: none };
  }
  if (filter.kind === "answered") {
    return { open: none, concluded: groups.concluded, answered: groups.answered, unknown: none };
  }
  return {
    open: groups.open.filter((item) => pendingPeople(item, isKnown).includes(filter.person)),
    concluded: none,
    answered: none,
    unknown: none,
  };
}

/** A filter read from storage, or null when it is not one. */
export function parseFilter(value: unknown): QuestionFilter | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, person } = value as Record<string, unknown>;
  if (kind === "open" || kind === "answered") return { kind };
  return kind === "person" && typeof person === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(person)
    ? { kind, person }
    : null;
}

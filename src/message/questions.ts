import type { Message, RepliesRequirement } from "./types";

export type QuestionStatus = "open" | "answered" | "concluded" | "unknown";

export interface QuestionProgress {
  readonly answered: number;
  readonly target: number;
}

export interface QuestionState {
  readonly question: Message;
  readonly state: QuestionStatus;
  readonly progress: QuestionProgress | null;
  readonly eligibleAnswerers: readonly string[];
  readonly answerers: readonly string[];
  readonly conclusion: Message | null;
  readonly conclusionText: string | null;
  /** Named info replies from the question's sender, oldest first. They never conclude it. */
  readonly reminders: readonly Message[];
}

export interface QuestionDerivationContext {
  /** False while the loader has not read the marker for the current revision. */
  readonly rosterKnown?: boolean;
  /** Topics with pending/unavailable files, or null when their topics are unknown. */
  readonly incompleteTopics?: readonly string[] | null;
}

function targetFor(
  requirement: RepliesRequirement | null,
  eligibleCount: number,
  broadcast: boolean,
): number {
  if (requirement === "any") return 1;
  if (requirement === "all") return eligibleCount;
  if (requirement === null) return broadcast ? 1 : eligibleCount;
  return requirement;
}

function bodyText(message: Message): string {
  return message.body.state === "plain" ? message.body.lines.join("\n") : "";
}

/**
 * Derive question progress from loaded messages and marker participants. A known empty roster
 * represents a repository with no participants and returns no states. An unread roster or
 * incomplete message coverage yields unknown states instead of inferred progress/conclusions.
 */
export function deriveQuestionStates(
  messages: readonly Message[],
  participants: readonly string[],
  formerParticipants: readonly string[] = [],
  context: QuestionDerivationContext = {},
): readonly QuestionState[] {
  const questions = messages.filter((message) => message.type === "question");
  if (context.rosterKnown === false) {
    return questions.map((question) => unknownState(question));
  }
  if (participants.length === 0) return [];
  const incompleteTopics = context.incompleteTopics;
  const roster = new Set(participants);
  const former = new Set(formerParticipants);
  const repliesByQuestion = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.replyTo === null) continue;
    const replies = repliesByQuestion.get(message.replyTo) ?? [];
    replies.push(message);
    repliesByQuestion.set(message.replyTo, replies);
  }

  return questions.map((question) => {
    const broadcast = question.to.length === 0;
    if (incompleteTopics === null || incompleteTopics?.includes(question.topic)) {
      return unknownState(question);
    }
    const candidates = question.replies === null && !broadcast ? question.to : participants;
    const eligibleAnswerers = [...new Set(candidates)].filter(
      (name) => roster.has(name) && name !== question.from && !former.has(name),
    );
    const eligible = new Set(eligibleAnswerers);
    const answerers = new Set<string>();
    let conclusion: Message | null = null;
    const reminders: Message[] = [];

    for (const message of repliesByQuestion.get(question.id) ?? []) {
      if (message.type === "answer" && eligible.has(message.from)) answerers.add(message.from);
      if (message.type === "info" && message.from === question.from) {
        // A named info from the sender is a reminder; only a broadcast info concludes.
        if (message.to.length > 0) reminders.push(message);
        else if (conclusion === null || message.id > conclusion.id) conclusion = message;
      }
    }

    const target = targetFor(question.replies, eligibleAnswerers.length, broadcast);
    const progress = { answered: Math.min(answerers.size, target), target };
    const state: QuestionStatus =
      conclusion !== null ? "concluded" : answerers.size >= target ? "answered" : "open";

    return {
      question,
      state,
      progress,
      eligibleAnswerers,
      answerers: eligibleAnswerers.filter((name) => answerers.has(name)),
      conclusion,
      conclusionText: conclusion === null ? null : bodyText(conclusion),
      reminders,
    };
  });
}

function unknownState(question: Message): QuestionState {
  return {
    question,
    state: "unknown",
    progress: null,
    eligibleAnswerers: [],
    answerers: [],
    conclusion: null,
    conclusionText: null,
    reminders: [],
  };
}

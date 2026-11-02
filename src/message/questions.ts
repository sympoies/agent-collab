import type { Message, RepliesRequirement } from "./types";

export type QuestionStatus = "open" | "answered" | "concluded";

export interface QuestionProgress {
  readonly answered: number;
  readonly target: number;
}

export interface QuestionState {
  readonly question: Message;
  readonly state: QuestionStatus;
  readonly progress: QuestionProgress;
  readonly eligibleAnswerers: readonly string[];
  readonly answerers: readonly string[];
  readonly conclusion: Message | null;
  readonly conclusionText: string | null;
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

/** Derive question progress from the currently loaded messages and marker participants. */
export function deriveQuestionStates(
  messages: readonly Message[],
  participants: readonly string[],
  formerParticipants: readonly string[] = [],
): readonly QuestionState[] {
  const former = new Set(formerParticipants);
  const questions = messages.filter((message) => message.type === "question");
  const repliesByQuestion = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.replyTo === null) continue;
    const replies = repliesByQuestion.get(message.replyTo) ?? [];
    replies.push(message);
    repliesByQuestion.set(message.replyTo, replies);
  }

  return questions.map((question) => {
    const broadcast = question.to.length === 0;
    const candidates = question.replies === null && !broadcast ? question.to : participants;
    const eligibleAnswerers = [...new Set(candidates)].filter(
      (name) => name !== question.from && !former.has(name),
    );
    const eligible = new Set(eligibleAnswerers);
    const answerers = new Set<string>();
    let conclusion: Message | null = null;

    for (const message of repliesByQuestion.get(question.id) ?? []) {
      if (message.type === "answer" && eligible.has(message.from)) answerers.add(message.from);
      if (message.type === "info" && message.from === question.from) {
        if (conclusion === null || message.id > conclusion.id) conclusion = message;
      }
    }

    const target = targetFor(question.replies, eligibleAnswerers.length, broadcast);
    const progress = { answered: answerers.size, target };
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
    };
  });
}

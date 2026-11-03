// Receipts and question grouping for the chat view (docs/design.md, section 5). An
// acknowledgement is an explicit reply message; the repository does not record who merely
// opened a message, so nothing here is a "read" receipt.

import type { QuestionState } from "./questions";
import type { Message } from "./types";

export interface Acknowledgement {
  readonly id: string;
  readonly from: string;
  /** "YYYY-MM-DD HH:MM" of the ack message. */
  readonly at: string;
  /** Text after "Expected reply:" in the ack body, or null. */
  readonly eta: string | null;
}

export type RecipientStatus = "answered" | "acknowledged" | "waiting";

export interface RecipientReceipt {
  readonly name: string;
  readonly state: RecipientStatus;
  readonly at: string | null;
}

export interface MessageReceipts {
  readonly acknowledgements: readonly Acknowledgement[];
  /** Every recipient with their state, or null when a broadcast's recipients are unknown. */
  readonly recipients: readonly RecipientReceipt[] | null;
  /** Derived progress and conclusion when the message is a question. */
  readonly question: QuestionState | null;
}

const ETA_RE = /expected reply:\s*(.+)$/i;

export function ackEta(message: Message): string | null {
  if (message.body.state !== "plain") return null;
  for (const line of message.body.lines) {
    const found = ETA_RE.exec(line);
    if (found !== null) return (found[1] ?? "").trim();
  }
  return null;
}

function isBroadcast(message: Message): boolean {
  return message.to.length === 0 || (message.to.length === 1 && message.to[0] === "all");
}

/**
 * Receipts for the questions, decisions and acknowledged messages among `messages`. Acks are
 * attached to the message they reply to; a message nobody acknowledged and that asks for no
 * answer has no receipts.
 */
export function buildReceipts(
  messages: readonly Message[],
  participants: readonly string[],
  formerParticipants: readonly string[],
  questionStates: readonly QuestionState[],
): ReadonlyMap<string, MessageReceipts> {
  const replies = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.replyTo === null) continue;
    const list = replies.get(message.replyTo) ?? [];
    list.push(message);
    replies.set(message.replyTo, list);
  }
  const states = new Map(questionStates.map((state) => [state.question.id, state]));
  const former = new Set(formerParticipants);
  const result = new Map<string, MessageReceipts>();

  for (const message of messages) {
    if (message.type === "ack") continue;
    const replyList = replies.get(message.id) ?? [];
    const latestAck = new Map<string, Message>();
    for (const reply of replyList) {
      if (reply.type !== "ack") continue;
      const previous = latestAck.get(reply.from);
      if (previous === undefined || reply.id > previous.id) latestAck.set(reply.from, reply);
    }
    const acks = [...latestAck.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const question = states.get(message.id) ?? null;
    if (message.type !== "question" && message.type !== "decision-needed" && acks.length === 0) {
      continue;
    }

    let names: readonly string[] | null;
    if (!isBroadcast(message)) names = message.to;
    else if (question !== null) {
      names = question.state === "unknown" ? null : question.eligibleAnswerers;
    } else if (participants.length === 0) names = null;
    else names = participants.filter((name) => name !== message.from && !former.has(name));

    const answerAt = new Map<string, string>();
    for (const reply of replyList) {
      if (reply.type !== "answer") continue;
      const previous = answerAt.get(reply.from);
      if (previous === undefined || reply.timestamp > previous)
        answerAt.set(reply.from, reply.timestamp);
    }
    const ackAt = new Map(acks.map((ack) => [ack.from, ack.timestamp]));

    result.set(message.id, {
      acknowledgements: acks.map((ack) => ({
        id: ack.id,
        from: ack.from,
        at: ack.timestamp,
        eta: ackEta(ack),
      })),
      recipients:
        names === null
          ? null
          : names.map((name): RecipientReceipt => {
              const answered = answerAt.get(name);
              if (answered !== undefined) return { name, state: "answered", at: answered };
              const acknowledged = ackAt.get(name);
              if (acknowledged !== undefined)
                return { name, state: "acknowledged", at: acknowledged };
              return { name, state: "waiting", at: null };
            }),
      question,
    });
  }
  return result;
}

export interface QuestionItem {
  readonly state: QuestionState;
  /** The viewer is an eligible answerer who has not answered an open question. */
  readonly waitingForViewer: boolean;
}

export interface QuestionGroups {
  readonly open: readonly QuestionItem[];
  readonly concluded: readonly QuestionItem[];
  readonly answered: readonly QuestionItem[];
  /** States that cannot be derived yet (roster or topic coverage incomplete). */
  readonly unknown: readonly QuestionItem[];
}

/** Groups questions by derived state, newest first; open questions waiting for the viewer lead. */
export function groupQuestions(
  states: readonly QuestionState[],
  viewer: string | null,
): QuestionGroups {
  const items = states
    .map((state): QuestionItem => ({
      state,
      waitingForViewer:
        viewer !== null &&
        state.state === "open" &&
        state.eligibleAnswerers.includes(viewer) &&
        !state.answerers.includes(viewer),
    }))
    .sort((a, b) => (a.state.question.id < b.state.question.id ? 1 : -1));
  const only = (status: QuestionState["state"]) =>
    items.filter((item) => item.state.state === status);
  return {
    open: [...only("open")].sort((a, b) => Number(b.waitingForViewer) - Number(a.waitingForViewer)),
    concluded: only("concluded"),
    answered: only("answered"),
    unknown: only("unknown"),
  };
}

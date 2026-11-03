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

/** An ETA line: "Expected reply: ..." optionally after "Received." and nothing else before it. */
const ETA_RE = /^\s*(?:received[.!]?\s*)?expected reply:\s*(.*)$/i;
const BOILERPLATE_RE = /^\s*received[.!]?\s*$/i;
const MAX_ETA_LENGTH = 100;

export function ackEta(message: Message): string | null {
  if (message.body.state !== "plain") return null;
  for (const line of message.body.lines) {
    const found = ETA_RE.exec(line);
    if (found === null) continue;
    const eta = (found[1] ?? "").trim();
    if (eta === "") return null;
    return eta.length > MAX_ETA_LENGTH ? `${eta.slice(0, MAX_ETA_LENGTH - 1)}\u2026` : eta;
  }
  return null;
}

/**
 * An acknowledgement that says nothing beyond "Received." and an ETA line. Plain acks are shown
 * as receipts under their message; any other ack keeps its own row so its text is not lost.
 */
export function isPlainAck(message: Message): boolean {
  if (message.type !== "ack") return false;
  if (message.body.state !== "plain") return false;
  return message.body.lines.every(
    (line) => line.trim() === "" || ETA_RE.test(line) || BOILERPLATE_RE.test(line),
  );
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
    const allAcks = replyList.filter((reply) => reply.type === "ack");
    // The latest ack of each sender (highest id) decides that sender's state.
    const latestAck = new Map<string, Message>();
    for (const reply of allAcks) {
      const previous = latestAck.get(reply.from);
      if (previous === undefined || reply.id > previous.id) latestAck.set(reply.from, reply);
    }
    // Only plain acks become receipt lines; the others keep their own row.
    const lines = allAcks.filter(isPlainAck).sort((a, b) => (a.id < b.id ? -1 : 1));
    const question = states.get(message.id) ?? null;
    if (message.type !== "question" && message.type !== "decision-needed" && allAcks.length === 0) {
      continue;
    }

    let names: readonly string[] | null;
    if (question !== null && question.state !== "unknown") {
      // The same people the derived N/M counts.
      names = question.eligibleAnswerers;
    } else if (!isBroadcast(message)) names = [...new Set(message.to)];
    else if (question !== null || participants.length === 0) names = null;
    else names = participants.filter((name) => name !== message.from && !former.has(name));

    const answerAt = new Map<string, string>();
    for (const reply of replyList) {
      if (reply.type !== "answer") continue;
      const previous = answerAt.get(reply.from);
      if (previous === undefined || reply.timestamp > previous)
        answerAt.set(reply.from, reply.timestamp);
    }
    const ackAt = new Map([...latestAck.values()].map((ack) => [ack.from, ack.timestamp]));

    result.set(message.id, {
      acknowledgements: lines.map((ack) => ({
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

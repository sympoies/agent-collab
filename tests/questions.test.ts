import { describe, expect, it } from "vitest";

import { parseMessageFile } from "../src/message/parse";
import { deriveQuestionStates } from "../src/message/questions";
import type { Message, ParsedFile } from "../src/message/types";

const PARTICIPANTS = ["alice-agent", "bob-agent", "carol-agent", "dana-agent"];

function parsed(
  minute: number,
  from: string,
  type: "question" | "answer" | "info" | "ack" | "decision-needed",
  fields: Record<string, string> = {},
  body = `${type} body ${minute}`,
): Message {
  const id = `2026-11-02T09${String(minute).padStart(2, "0")}-${from}-api-01`;
  const text = [
    "---",
    `id: ${id}`,
    `from: ${from}`,
    `to: ${fields.to ?? "all"}`,
    "topic: api",
    `type: ${type}`,
    `reply_to: ${fields.reply_to ?? ""}`,
    "needs: none",
    ...Object.entries(fields)
      .filter(([key]) => key !== "to" && key !== "reply_to")
      .map(([k, v]) => `${k}: ${v}`),
    "---",
    body,
  ].join("\n");
  const result: ParsedFile = parseMessageFile(`inbox/2026-11/${id}.md`, text);
  if (result.kind !== "message") throw new Error(result.errors.join("; "));
  return result.message;
}

function derive(messages: readonly Message[]) {
  return deriveQuestionStates(messages, PARTICIPANTS, ["dana-agent"]);
}

describe("deriveQuestionStates", () => {
  it.each([
    {
      name: "broadcast any needs one distinct eligible answer",
      question: parsed(1, "alice-agent", "question", { replies: "any" }),
      answers: [
        parsed(2, "bob-agent", "answer", { reply_to: "2026-11-02T0901-alice-agent-api-01" }),
      ],
      progress: { answered: 1, target: 1 },
      state: "answered",
      eligible: ["bob-agent", "carol-agent"],
    },
    {
      name: "broadcast without replies defaults to one answer",
      question: parsed(1, "alice-agent", "question"),
      answers: [
        parsed(2, "bob-agent", "answer", { reply_to: "2026-11-02T0901-alice-agent-api-01" }),
      ],
      progress: { answered: 1, target: 1 },
      state: "answered",
      eligible: ["bob-agent", "carol-agent"],
    },
    {
      name: "broadcast all excludes the sender and former participants",
      question: parsed(1, "alice-agent", "question", { replies: "all" }),
      answers: [
        parsed(2, "bob-agent", "answer", { reply_to: "2026-11-02T0901-alice-agent-api-01" }),
      ],
      progress: { answered: 1, target: 2 },
      state: "open",
      eligible: ["bob-agent", "carol-agent"],
    },
    {
      name: "broadcast all is answered after each eligible participant answers",
      question: parsed(1, "alice-agent", "question", { replies: "all" }),
      answers: [
        parsed(2, "bob-agent", "answer", { reply_to: "2026-11-02T0901-alice-agent-api-01" }),
        parsed(3, "carol-agent", "answer", { reply_to: "2026-11-02T0901-alice-agent-api-01" }),
      ],
      progress: { answered: 2, target: 2 },
      state: "answered",
      eligible: ["bob-agent", "carol-agent"],
    },
    {
      name: "named recipients are the default eligible answerers",
      question: parsed(1, "alice-agent", "question", { to: "bob-agent, carol-agent" }),
      answers: [],
      progress: { answered: 0, target: 2 },
      state: "open",
      eligible: ["bob-agent", "carol-agent"],
    },
    {
      name: "numeric replies overrides the target while retaining named recipients",
      question: parsed(1, "alice-agent", "question", { to: "bob-agent", replies: "1" }),
      answers: [],
      progress: { answered: 0, target: 1 },
      state: "open",
      eligible: ["bob-agent", "carol-agent"],
    },
    {
      name: "numeric replies counts eligible participants outside the named to list",
      question: parsed(1, "alice-agent", "question", { to: "bob-agent", replies: "2" }),
      answers: [
        parsed(2, "bob-agent", "answer", { reply_to: "2026-11-02T0901-alice-agent-api-01" }),
        parsed(3, "carol-agent", "answer", { reply_to: "2026-11-02T0901-alice-agent-api-01" }),
      ],
      progress: { answered: 2, target: 2 },
      state: "answered",
      eligible: ["bob-agent", "carol-agent"],
    },
  ])("derives $name", ({ question, answers, progress, state, eligible }) => {
    const [result] = derive([question, ...answers]);
    expect(result).toMatchObject({
      question,
      progress,
      state,
      eligibleAnswerers: eligible,
    });
  });

  it.each([
    ["any", { answered: 1, target: 1 }, "answered"],
    ["all", { answered: 1, target: 2 }, "open"],
  ] as const)(
    "lets a named question with replies=%s use the participant roster",
    (replies, progress, state) => {
      const question = parsed(1, "alice-agent", "question", { to: "bob-agent", replies });
      const answer = parsed(2, "carol-agent", "answer", { reply_to: question.id });
      expect(derive([question, answer])[0]).toMatchObject({
        progress,
        state,
        eligibleAnswerers: ["bob-agent", "carol-agent"],
        answerers: ["carol-agent"],
      });
    },
  );

  it("counts distinct eligible answerers and never counts acknowledgments", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "all" });
    const replyTo = question.id;
    const states = derive([
      question,
      parsed(2, "bob-agent", "answer", { reply_to: replyTo }),
      parsed(3, "bob-agent", "answer", { reply_to: replyTo }),
      parsed(4, "carol-agent", "ack", { reply_to: replyTo }),
      parsed(5, "carol-agent", "ack", { reply_to: replyTo }, "Expected reply today"),
      parsed(6, "carol-agent", "ack", { reply_to: replyTo }, ""),
      parsed(7, "dana-agent", "answer", { reply_to: replyTo }),
      parsed(8, "alice-agent", "answer", { reply_to: replyTo }),
      parsed(9, "bob-agent", "decision-needed", { reply_to: replyTo }),
    ]);
    expect(states[0]).toMatchObject({
      progress: { answered: 1, target: 2 },
      answerers: ["bob-agent"],
      state: "open",
    });
  });

  it("uses the last sender-authored info reply as the conclusion", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "any" });
    const first = parsed(2, "alice-agent", "info", { reply_to: question.id }, "First conclusion");
    const last = parsed(4, "alice-agent", "info", { reply_to: question.id }, "Final conclusion");
    const notConclusion = parsed(3, "bob-agent", "info", { reply_to: question.id }, "Other note");
    const result = derive([question, first, notConclusion, last])[0];
    expect(result).toMatchObject({
      state: "concluded",
      conclusion: last,
      conclusionText: "Final conclusion",
    });
  });

  it("returns one state per question and ignores unrelated replies", () => {
    const first = parsed(1, "alice-agent", "question", { replies: "2" });
    const second = parsed(2, "bob-agent", "question", { to: "carol-agent" });
    const response = parsed(3, "carol-agent", "answer", { reply_to: second.id });
    const states = derive([first, second, response]);
    expect(states.map(({ question, state }) => [question.id, state])).toEqual([
      [first.id, "open"],
      [second.id, "answered"],
    ]);
  });
});

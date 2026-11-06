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

  it("treats a named info from the sender as a reminder that keeps the question open", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "any" });
    const first = parsed(2, "alice-agent", "info", { reply_to: question.id, to: "bob-agent" });
    const second = parsed(3, "alice-agent", "info", { reply_to: question.id, to: "bob-agent" });
    expect(derive([question, first, second])[0]).toMatchObject({
      state: "open",
      conclusion: null,
      conclusionText: null,
      reminders: [first, second],
    });
  });

  it("lists every answer and acknowledgement reply, oldest first, whoever sent them", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "all", to: "bob-agent" });
    const ack = parsed(2, "bob-agent", "ack", { reply_to: question.id, to: "alice-agent" });
    const late = parsed(5, "bob-agent", "answer", { reply_to: question.id, to: "alice-agent" });
    const early = parsed(3, "carol-agent", "answer", { reply_to: question.id, to: "alice-agent" });
    const other = parsed(4, "bob-agent", "answer", { reply_to: "2026-11-02T0900-x-api-01" });
    const state = derive([question, late, ack, other, early])[0];
    expect(state?.answers).toEqual([early, late]);
    expect(state?.acks).toEqual([ack]);
  });

  it("collects a reply by reply_to whatever its topic", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "any", to: "bob-agent" });
    const elsewhere = {
      ...parsed(2, "bob-agent", "answer", { reply_to: question.id }),
      topic: "ops",
    };
    expect(derive([question, elsewhere])[0]).toMatchObject({
      state: "answered",
      answers: [elsewhere],
    });
  });

  it.each([["all"], [""]])("concludes on a broadcast info (to: %j)", (to) => {
    const question = parsed(1, "alice-agent", "question", { replies: "any" });
    const info = parsed(2, "alice-agent", "info", { reply_to: question.id, to }, "Decided.");
    expect(derive([question, info])[0]).toMatchObject({
      state: "concluded",
      conclusionText: "Decided.",
      reminders: [],
    });
  });

  it("never concludes on an info from someone else, named or broadcast", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "any" });
    const named = parsed(2, "bob-agent", "info", { reply_to: question.id, to: "alice-agent" });
    const broadcast = parsed(3, "carol-agent", "info", { reply_to: question.id });
    expect(derive([question, named, broadcast])[0]).toMatchObject({
      state: "open",
      conclusion: null,
      reminders: [],
    });
  });

  it("concludes with the broadcast text after several reminders", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "any" });
    const reminders = [2, 3].map((minute) =>
      parsed(minute, "alice-agent", "info", { reply_to: question.id, to: "bob-agent" }, "Ping."),
    );
    const final = parsed(4, "alice-agent", "info", { reply_to: question.id }, "Final text.");
    const late = parsed(
      5,
      "alice-agent",
      "info",
      { reply_to: question.id, to: "bob-agent" },
      "Late ping.",
    );
    expect(derive([question, ...reminders, final, late])[0]).toMatchObject({
      state: "concluded",
      conclusion: final,
      conclusionText: "Final text.",
      reminders: [...reminders, late],
    });
  });

  it("does not count a named info without reply_to as a reminder", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "any" });
    const loose = parsed(2, "alice-agent", "info", { to: "bob-agent" });
    expect(derive([question, loose])[0]).toMatchObject({ state: "open", reminders: [] });
  });

  it("follows the parser: a recipient list containing all is a broadcast and concludes", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "any" });
    const info = parsed(2, "alice-agent", "info", { reply_to: question.id, to: "all, bob-agent" });
    expect(derive([question, info])[0]).toMatchObject({ state: "concluded", reminders: [] });
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

  it.each([
    ["any", ["bob-agent", "carol-agent"], { answered: 1, target: 1 }],
    ["2", ["bob-agent", "carol-agent", "erin-agent"], { answered: 2, target: 2 }],
  ] as const)("caps replies=%s progress at its target", (replies, answerers, progress) => {
    const question = parsed(1, "alice-agent", "question", { replies });
    const participants = ["alice-agent", "bob-agent", "carol-agent", "erin-agent"];
    const answers = answerers.map((from, index) =>
      parsed(index + 2, from, "answer", { reply_to: question.id }),
    );
    expect(
      deriveQuestionStates([question, ...answers], participants, ["dana-agent"])[0],
    ).toMatchObject({
      progress,
      answerers,
      state: "answered",
    });
  });

  it("does not make an unlisted, nonparticipant a named answerer", () => {
    const question = parsed(1, "alice-agent", "question", { to: "bob-agent, zed-agent" });
    const answer = parsed(2, "zed-agent", "answer", { reply_to: question.id });
    expect(derive([question, answer])[0]).toMatchObject({
      eligibleAnswerers: ["bob-agent"],
      answerers: [],
      progress: { answered: 0, target: 1 },
      state: "open",
    });
  });

  it("returns unknown without a loaded roster and no states for a known empty roster", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "any" });
    expect(
      deriveQuestionStates([question], PARTICIPANTS, [], { rosterKnown: false })[0],
    ).toMatchObject({
      state: "unknown",
      progress: null,
      conclusion: null,
      conclusionText: null,
    });
    expect(deriveQuestionStates([question], [], [], { rosterKnown: true })).toEqual([]);
  });

  // An unloaded message can only change a question's state when it is not older than the
  // question: replies, acknowledgements, reminders and conclusions come after it.
  describe("unknown only when a newer message may be unloaded", () => {
    const question = parsed(5, "alice-agent", "question", { replies: "any" });
    const answer = parsed(6, "bob-agent", "answer", { reply_to: question.id });
    const state = (incompleteTopics: Record<string, string> | null) =>
      deriveQuestionStates([question, answer], PARTICIPANTS, [], {
        rosterKnown: true,
        incompleteTopics,
      })[0];
    const idAt = (n: number) => parsed(n, "bob-agent", "answer", {}).id;

    it("gives the real state while only older messages are unloaded", () => {
      expect(state({ api: idAt(4) })).toMatchObject({
        state: "answered",
        progress: { answered: 1, target: 1 },
      });
    });

    it("is unknown when an unloaded message is newer than the question", () => {
      expect(state({ api: idAt(7) })).toMatchObject({
        state: "unknown",
        progress: null,
        conclusion: null,
      });
    });

    it("is unknown when an unloaded message is from the same minute as the question", () => {
      expect(state({ api: idAt(5) })).toMatchObject({
        state: "unknown",
        progress: null,
        conclusion: null,
      });
    });

    it("ignores unloaded messages of another topic and stays unknown when topics are unknown", () => {
      expect(state({ ops: idAt(9) })).toMatchObject({ state: "answered" });
      expect(state(null)).toMatchObject({ state: "unknown", progress: null, conclusion: null });
    });
  });

  it("does not conclude a question from a non-sender info reply", () => {
    const question = parsed(1, "alice-agent", "question", { replies: "any" });
    const note = parsed(2, "bob-agent", "info", { reply_to: question.id }, "A note");
    expect(derive([question, note])[0]).toMatchObject({
      state: "open",
      conclusion: null,
      conclusionText: null,
    });
  });
});

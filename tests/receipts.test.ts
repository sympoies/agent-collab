import { describe, expect, it } from "vitest";

import { parseMessageFile } from "../src/message/parse";
import { deriveQuestionStates } from "../src/message/questions";
import { ackEta, buildReceipts, groupQuestions, isPlainAck } from "../src/message/receipts";
import type { Message } from "../src/message/types";

const ROSTER = ["alice-agent", "bob-agent", "carol-agent", "dana-agent"];
const FORMER = ["dana-agent"];

function message(
  minute: number,
  from: string,
  type: "question" | "answer" | "info" | "ack" | "decision-needed",
  fields: Record<string, string> = {},
  body = type === "ack" ? "Received." : `${type} ${String(minute)}`,
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
      .map(([key, value]) => `${key}: ${value}`),
    "---",
    body,
  ].join("\n");
  const parsed = parseMessageFile(`inbox/2026-11/${id}.md`, text);
  if (parsed.kind !== "message") throw new Error(parsed.errors.join("; "));
  return parsed.message;
}

function receipts(messages: readonly Message[]) {
  const states = deriveQuestionStates(messages, ROSTER, FORMER, {
    rosterKnown: true,
    incompleteTopics: [],
  });
  return buildReceipts(messages, ROSTER, FORMER, states);
}

describe("ackEta", () => {
  it("reads the expected reply from an ack body and ignores other text", () => {
    expect(
      ackEta(message(1, "bob-agent", "ack", {}, "Received. Expected reply: within 10 minutes")),
    ).toBe("within 10 minutes");
    expect(ackEta(message(1, "bob-agent", "ack", {}, "Received."))).toBeNull();
    expect(ackEta(message(1, "bob-agent", "ack", {}, ""))).toBeNull();
  });
});

describe("buildReceipts", () => {
  it("lists who acknowledged a message, when, and with which ETA", () => {
    const info = message(1, "alice-agent", "decision-needed", { to: "bob-agent, carol-agent" });
    const ack = message(
      3,
      "bob-agent",
      "ack",
      { reply_to: info.id },
      "Received. Expected reply: within 5 minutes",
    );
    const found = receipts([info, ack]).get(info.id);
    expect(found?.acknowledgements).toEqual([
      { id: ack.id, from: "bob-agent", at: "2026-11-02 09:03", eta: "within 5 minutes" },
    ]);
    expect(found?.recipients).toEqual([
      { name: "bob-agent", state: "acknowledged", at: "2026-11-02 09:03" },
      { name: "carol-agent", state: "waiting", at: null },
    ]);
  });

  it("prefers an answer over an acknowledgement; a wordy ack keeps its own row", () => {
    const question = message(1, "alice-agent", "question", { to: "bob-agent" });
    const firstAck = message(2, "bob-agent", "ack", { reply_to: question.id });
    const secondAck = message(3, "bob-agent", "ack", { reply_to: question.id }, "Still working");
    const answer = message(5, "bob-agent", "answer", { reply_to: question.id });
    const found = receipts([question, firstAck, secondAck, answer]).get(question.id);
    expect(found?.acknowledgements.map((ack) => ack.id)).toEqual([firstAck.id]);
    expect(found?.recipients).toEqual([
      { name: "bob-agent", state: "answered", at: "2026-11-02 09:05" },
    ]);
  });

  it("derives broadcast recipients from the roster, without the sender or former participants", () => {
    const question = message(1, "alice-agent", "question", { replies: "all" });
    const answer = message(2, "bob-agent", "answer", { reply_to: question.id });
    const found = receipts([question, answer]).get(question.id);
    expect(found?.recipients?.map((recipient) => [recipient.name, recipient.state])).toEqual([
      ["bob-agent", "answered"],
      ["carol-agent", "waiting"],
    ]);
    expect(found?.question?.progress).toEqual({ answered: 1, target: 2 });
  });

  it("has no recipient list for a broadcast when the roster is unknown", () => {
    const question = message(1, "alice-agent", "question");
    const states = deriveQuestionStates([question], [], [], { rosterKnown: false });
    expect(buildReceipts([question], [], [], states).get(question.id)?.recipients).toBeNull();
  });

  it("tracks only questions, decisions and messages that were acknowledged", () => {
    const quiet = message(1, "alice-agent", "info");
    const acknowledged = message(2, "alice-agent", "info");
    const ack = message(3, "bob-agent", "ack", { reply_to: acknowledged.id });
    const found = receipts([quiet, acknowledged, ack]);
    expect(found.has(quiet.id)).toBe(false);
    expect(found.has(acknowledged.id)).toBe(true);
    expect(found.has(ack.id)).toBe(false);
  });

  it("carries the conclusion of a question", () => {
    const question = message(1, "alice-agent", "question", { replies: "any" });
    const conclusion = message(
      4,
      "alice-agent",
      "info",
      { reply_to: question.id },
      "We chose option B.",
    );
    const found = receipts([question, conclusion]).get(question.id);
    expect(found?.question?.state).toBe("concluded");
    expect(found?.question?.conclusionText).toBe("We chose option B.");
  });
});

describe("groupQuestions", () => {
  const open = message(1, "alice-agent", "question", { replies: "all" });
  const answered = message(2, "alice-agent", "question", { replies: "any" });
  const concluded = message(3, "alice-agent", "question", { replies: "any" });
  const messages = [
    open,
    answered,
    message(4, "bob-agent", "answer", { reply_to: answered.id }),
    concluded,
    message(6, "alice-agent", "info", { reply_to: concluded.id }, "Done."),
    message(7, "bob-agent", "answer", { reply_to: open.id }),
  ];
  const states = deriveQuestionStates(messages, ROSTER, FORMER, {
    rosterKnown: true,
    incompleteTopics: [],
  });

  it("groups by open, concluded and answered, newest first", () => {
    const groups = groupQuestions(states, null);
    expect(groups.open.map((item) => item.state.question.id)).toEqual([open.id]);
    expect(groups.answered.map((item) => item.state.question.id)).toEqual([answered.id]);
    expect(groups.concluded.map((item) => item.state.question.id)).toEqual([concluded.id]);
    expect(groups.unknown).toEqual([]);
  });

  it("flags open questions still waiting for the viewer and lists them first", () => {
    const other = message(8, "alice-agent", "question", { replies: "all" });
    const withOther = deriveQuestionStates([...messages, other], ROSTER, FORMER, {
      rosterKnown: true,
      incompleteTopics: [],
    });
    const asBob = groupQuestions(withOther, "bob-agent").open;
    // Bob answered the first question already; only the newer one waits for him.
    expect(asBob.map((item) => [item.state.question.id, item.waitingForViewer])).toEqual([
      [other.id, true],
      [open.id, false],
    ]);
    expect(groupQuestions(withOther, null).open.every((item) => !item.waitingForViewer)).toBe(true);
  });

  it("puts questions with unknown state in their own group", () => {
    const unknown = deriveQuestionStates([open], [], [], { rosterKnown: false });
    expect(groupQuestions(unknown, null).unknown).toHaveLength(1);
  });
});

describe("ack bodies and ETAs", () => {
  const ack = (body: string) => message(1, "bob-agent", "ack", {}, body);

  it.each([
    ["Received. Expected reply: within 5 minutes", "within 5 minutes"],
    ["Expected reply: Friday", "Friday"],
    ["  expected REPLY:   tomorrow  ", "tomorrow"],
    ["Expected reply:    ", null],
    ["Expected reply:", null],
    ["Looking into it. Expected reply: Friday. Blocked on X", null],
    ["I will not say when. expected reply soon", null],
    ["", null],
    [`Expected reply: ${"x".repeat(300)}`, `${"x".repeat(99)}\u2026`],
  ])("reads the ETA of %j as %j", (body, eta) => {
    expect(ackEta(ack(body))).toBe(eta);
  });

  it.each([
    ["", true],
    ["Received.", true],
    ["received", true],
    ["Received. Expected reply: within 10 minutes", true],
    ["Expected reply: Friday", true],
    ["Received.\nExpected reply: Friday", true],
    ["Looking into it. Blocked on X", false],
    ["Received. Blocked on X", false],
    ["Looking into it. Expected reply: Friday. Blocked on X", false],
  ])("treats an ack with body %j as plain: %s", (body, plain) => {
    expect(isPlainAck(ack(body))).toBe(plain);
  });

  it("lists only plain acks as receipt lines but counts every ack for the recipient state", () => {
    const question = message(1, "alice-agent", "question", { to: "bob-agent" });
    const plain = message(2, "bob-agent", "ack", { reply_to: question.id }, "Received.");
    const wordy = message(
      3,
      "bob-agent",
      "ack",
      { reply_to: question.id },
      "Looking into it. Blocked on X",
    );
    const found = receipts([question, plain, wordy]).get(question.id);
    expect(found?.acknowledgements.map((item) => item.id)).toEqual([plain.id]);
    expect(found?.recipients).toEqual([
      { name: "bob-agent", state: "acknowledged", at: "2026-11-02 09:03" },
    ]);
  });

  it("keeps every plain ack of one sender, oldest first", () => {
    const info = message(1, "alice-agent", "info", { to: "bob-agent" });
    const first = message(2, "bob-agent", "ack", { reply_to: info.id }, "Received.");
    const second = message(
      4,
      "bob-agent",
      "ack",
      { reply_to: info.id },
      "Received again.\nExpected reply: Friday",
    );
    const found = receipts([second, info, first]).get(info.id);
    expect(found?.acknowledgements.map((item) => item.id)).toEqual([first.id]);
    const third = message(5, "bob-agent", "ack", { reply_to: info.id }, "");
    expect(
      receipts([info, first, third])
        .get(info.id)
        ?.acknowledgements.map((item) => item.id),
    ).toEqual([first.id, third.id]);
  });
});

describe("recipient lists follow the derived question state", () => {
  it("uses the eligible answerers for a named question: no duplicates, sender, ghost or former", () => {
    const question = message(1, "alice-agent", "question", {
      to: "bob-agent, bob-agent, alice-agent, ghost-agent, dana-agent",
    });
    const answer = message(2, "bob-agent", "answer", { reply_to: question.id });
    const found = receipts([question, answer]).get(question.id);
    expect(found?.recipients).toEqual([
      { name: "bob-agent", state: "answered", at: "2026-11-02 09:02" },
    ]);
    expect(found?.question?.progress).toEqual({ answered: 1, target: 1 });
  });

  it("does not show an answer from a non-eligible person as answered", () => {
    const question = message(1, "alice-agent", "question", { to: "bob-agent" });
    const stray = message(2, "carol-agent", "answer", { reply_to: question.id });
    const found = receipts([question, stray]).get(question.id);
    expect(found?.recipients).toEqual([{ name: "bob-agent", state: "waiting", at: null }]);
    expect(found?.question?.progress).toEqual({ answered: 0, target: 1 });
  });

  it("de-duplicates the named recipients of a message that is not a question", () => {
    const info = message(1, "alice-agent", "decision-needed", { to: "bob-agent, bob-agent" });
    expect(
      receipts([info])
        .get(info.id)
        ?.recipients?.map((recipient) => recipient.name),
    ).toEqual(["bob-agent"]);
  });

  it("shows mixed states for a replies-all question: 2 of 3 answered", () => {
    const wide = ["alice-agent", "bob-agent", "carol-agent", "erin-agent"];
    const question = message(1, "alice-agent", "question", { replies: "all" });
    const messages = [
      question,
      message(2, "bob-agent", "answer", { reply_to: question.id }),
      message(3, "carol-agent", "answer", { reply_to: question.id }),
      message(4, "erin-agent", "ack", { reply_to: question.id }),
    ];
    const states = deriveQuestionStates(messages, wide, [], {
      rosterKnown: true,
      incompleteTopics: [],
    });
    const found = buildReceipts(messages, wide, [], states).get(question.id);
    expect(found?.question?.progress).toEqual({ answered: 2, target: 3 });
    expect(found?.recipients?.map((recipient) => [recipient.name, recipient.state])).toEqual([
      ["bob-agent", "answered"],
      ["carol-agent", "answered"],
      ["erin-agent", "acknowledged"],
    ]);
  });

  it("treats an empty `to` as a broadcast", () => {
    const info = message(1, "alice-agent", "decision-needed", { to: "" });
    const found = receipts([info]).get(info.id);
    expect(found?.recipients?.map((recipient) => recipient.name)).toEqual([
      "bob-agent",
      "carol-agent",
    ]);
  });

  it("shows an ack from a non-recipient as a line but not as a recipient", () => {
    const info = message(1, "alice-agent", "decision-needed", { to: "bob-agent" });
    const outsider = message(2, "carol-agent", "ack", { reply_to: info.id });
    const found = receipts([info, outsider]).get(info.id);
    expect(found?.acknowledgements.map((item) => item.from)).toEqual(["carol-agent"]);
    expect(found?.recipients).toEqual([{ name: "bob-agent", state: "waiting", at: null }]);
  });

  it("keeps an ack timestamped before its message, and the highest id as the latest ack", () => {
    const info = message(5, "alice-agent", "decision-needed", { to: "bob-agent" });
    const early = message(2, "bob-agent", "ack", { reply_to: info.id });
    const late = message(8, "bob-agent", "ack", { reply_to: info.id });
    const found = receipts([late, info, early]).get(info.id);
    expect(found?.acknowledgements.map((item) => item.at)).toEqual([
      "2026-11-02 09:02",
      "2026-11-02 09:08",
    ]);
    expect(found?.recipients).toEqual([
      { name: "bob-agent", state: "acknowledged", at: "2026-11-02 09:08" },
    ]);
  });

  it("carries the conclusion together with the answers", () => {
    const question = message(1, "alice-agent", "question", { replies: "all" });
    const messages = [
      question,
      message(2, "bob-agent", "answer", { reply_to: question.id }),
      message(3, "carol-agent", "answer", { reply_to: question.id }),
      message(4, "alice-agent", "info", { reply_to: question.id }, "Decided."),
    ];
    const found = receipts(messages).get(question.id);
    expect(found?.question?.state).toBe("concluded");
    expect(found?.question?.conclusionText).toBe("Decided.");
    expect(found?.recipients?.map((recipient) => recipient.state)).toEqual([
      "answered",
      "answered",
    ]);
  });
});

describe("groupQuestions flags", () => {
  const open = message(1, "alice-agent", "question", { replies: "all" });
  const answered = message(2, "alice-agent", "question", { replies: "any" });
  const concluded = message(3, "alice-agent", "question", { replies: "any" });
  const messages = [
    open,
    answered,
    message(4, "carol-agent", "answer", { reply_to: answered.id }),
    concluded,
    message(6, "alice-agent", "info", { reply_to: concluded.id }, "Done."),
  ];
  const states = deriveQuestionStates(messages, ROSTER, FORMER, {
    rosterKnown: true,
    incompleteTopics: [],
  });

  it("flags only open questions the viewer still has to answer", () => {
    const asBob = groupQuestions(states, "bob-agent");
    expect(asBob.open.map((item) => item.waitingForViewer)).toEqual([true]);
    // Bob is an eligible answerer of the other two, but they are answered and concluded.
    expect(asBob.answered.map((item) => item.waitingForViewer)).toEqual([false]);
    expect(asBob.concluded.map((item) => item.waitingForViewer)).toEqual([false]);
  });

  it("does not flag the asker or a viewer who is not in the roster", () => {
    for (const viewer of ["alice-agent", "ghost-agent", "dana-agent", null]) {
      expect(groupQuestions(states, viewer).open.map((item) => item.waitingForViewer)).toEqual([
        false,
      ]);
    }
  });
});

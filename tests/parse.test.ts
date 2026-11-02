import { describe, expect, it } from "vitest";

import { parseMessageFile } from "../src/message/parse";
import type { Message, ParsedFile } from "../src/message/types";

const ID = "2026-10-08T0905-alice-agent-api-01";
const PATH = `inbox/2026-10/${ID}.md`;

const FIELDS: Record<string, string> = {
  id: ID,
  from: "alice-agent",
  to: "bob-agent",
  topic: "api",
  type: "question",
  reply_to: "",
  refs: "topics/api/fields-v1.md",
  needs: "confirm the field list",
  due: "2026-10-10",
};

function file(
  overrides: Record<string, string | null> = {},
  body = "Please review the field draft in refs.",
): string {
  const lines = Object.entries({ ...FIELDS, ...overrides })
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}: ${value}`.trimEnd());
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

function message(result: ParsedFile): Message {
  if (result.kind !== "message") {
    throw new Error(`expected a message, got malformed: ${result.errors.join("; ")}`);
  }
  return result.message;
}

function errors(result: ParsedFile): readonly string[] {
  if (result.kind !== "malformed") {
    throw new Error(`expected malformed, got message ${result.message.id}`);
  }
  return result.errors;
}

describe("parseMessageFile: valid messages", () => {
  it("parses every field of a well-formed message", () => {
    const result = message(parseMessageFile(PATH, file()));
    expect(result).toEqual({
      id: ID,
      path: PATH,
      timestamp: "2026-10-08 09:05",
      from: "alice-agent",
      to: ["bob-agent"],
      topic: "api",
      type: "question",
      replyTo: null,
      replies: null,
      refs: ["topics/api/fields-v1.md"],
      needs: "confirm the field list",
      due: "2026-10-10",
      body: { state: "plain", lines: ["Please review the field draft in refs."] },
      issues: [],
    });
  });

  it("accepts CRLF line endings and the flat layout", () => {
    const text = file().replaceAll("\n", "\r\n");
    const result = message(parseMessageFile(`inbox/${ID}.md`, text));
    expect(result.body).toEqual({
      state: "plain",
      lines: ["Please review the field draft in refs."],
    });
    expect(result.issues).toEqual([]);
  });

  it("splits comma-separated recipients and refs and trims them", () => {
    const result = message(
      parseMessageFile(
        PATH,
        file({
          to: "bob-agent, carol-agent",
          refs: "topics/a.md , 2026-10-01T0800-bob-agent-api-01",
        }),
      ),
    );
    expect(result.to).toEqual(["bob-agent", "carol-agent"]);
    expect(result.refs).toEqual(["topics/a.md", "2026-10-01T0800-bob-agent-api-01"]);
  });

  it.each(["", "all"])("treats to=%s as the everyone recipient", (to) => {
    const result = message(parseMessageFile(PATH, file({ to })));
    expect(result.to).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("treats all in a named recipient list as broadcast", () => {
    const result = message(parseMessageFile(PATH, file({ to: "bob-agent, all" })));
    expect(result.to).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it.each([
    ["any", "any"],
    ["all", "all"],
    ["3", 3],
  ] as const)("parses question replies=%s", (raw, expected) => {
    expect(message(parseMessageFile(PATH, file({ replies: raw })))).toMatchObject({
      replies: expected,
      issues: [],
    });
  });

  it("ignores a replies requirement on non-question messages", () => {
    const result = message(parseMessageFile(PATH, file({ type: "info", replies: "all" })));
    expect(result.replies).toBeNull();
    expect(result.issues).toContain("replies applies only to question messages");
  });

  it("accepts an empty-body acknowledgment without a body validation issue", () => {
    const result = message(
      parseMessageFile(
        PATH,
        file(
          {
            type: "ack",
            reply_to: "2026-10-08T0900-bob-agent-api-01",
            to: "alice-agent",
          },
          "",
        ),
      ),
    );
    expect(result.body).toEqual({ state: "plain", lines: [] });
    expect(result.issues).not.toContain("body is empty");
  });

  it.each(["", "0", "-1", "1.5", "ANY", "many"])(
    "keeps an invalid question replies value %j as a soft issue",
    (replies) => {
      const result = message(parseMessageFile(PATH, file({ replies })));
      expect(result.type).toBe("question");
      expect(result.replies).toBeNull();
      expect(result.issues).toContain(
        `replies must be any, all, or a positive integer: ${replies}`,
      );
    },
  );

  it("maps a 'none' request to null in any case", () => {
    expect(message(parseMessageFile(PATH, file({ needs: "None" }))).needs).toBeNull();
    expect(message(parseMessageFile(PATH, file({ needs: "無" }))).needs).toBeNull();
  });

  it("ignores a leading byte order mark", () => {
    const result = parseMessageFile(PATH, `\uFEFF${file()}`);
    expect(result).toMatchObject({ kind: "message", message: { id: ID, issues: [] } });
  });

  it("keeps inner blank lines but trims blank lines around the body", () => {
    const result = message(parseMessageFile(PATH, file({}, "\n\nfirst\n\nsecond\n\n")));
    expect(result.body).toEqual({ state: "plain", lines: ["first", "", "second"] });
  });

  it("keeps a reply_to and accepts an answer that has one", () => {
    const parent = "2026-10-08T0900-bob-agent-api-01";
    const result = message(parseMessageFile(PATH, file({ type: "answer", reply_to: parent })));
    expect(result.type).toBe("answer");
    expect(result.replyTo).toBe(parent);
    expect(result.issues).toEqual([]);
  });

  it("treats an age-armored body as locked and keeps the armor", () => {
    const armored = [
      "-----BEGIN AGE ENCRYPTED FILE-----",
      "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBwbGFjZWhvbGRlcgo=",
      "cGxhY2Vob2xkZXIgY2lwaGVydGV4dCwgbm90IGEgcmVhbCBtZXNzYWdlCg==",
      "bm90IGEgcmVhbCBtZXNzYWdlIGVpdGhlcgo=",
      "cGxhY2Vob2xkZXIK",
      "cGxhY2Vob2xkZXIK",
      "-----END AGE ENCRYPTED FILE-----",
    ].join("\n");
    const result = message(parseMessageFile(PATH, file({}, armored)));
    expect(result.body).toEqual({ state: "locked", armored });
    expect(result.issues).toEqual([]);
  });
});

describe("parseMessageFile: fatal problems produce a malformed file", () => {
  it.each([
    ["no opening delimiter", "id: x\n---\nbody\n", "front matter must start with a '---' line"],
    ["no closing delimiter", "---\nid: x\nbody\n", "front matter is not closed by a '---' line"],
    ["empty file", "", "front matter must start with a '---' line"],
  ])("rejects %s", (_name, text, expected) => {
    expect(errors(parseMessageFile(PATH, text))).toEqual([expected]);
  });

  it("rejects a front matter line without a colon", () => {
    const text = file().replace("topic: api", "topic api");
    expect(errors(parseMessageFile(PATH, text))).toContain(
      "front matter line is not 'key: value': topic api",
    );
  });

  it("rejects a duplicate key", () => {
    const text = file().replace("topic: api", "topic: api\ntopic: other");
    expect(errors(parseMessageFile(PATH, text))).toContain("duplicate front matter key: topic");
  });

  it.each(["id", "from", "to", "topic"])("rejects a missing %s", (key) => {
    expect(errors(parseMessageFile(PATH, file({ [key]: null })))).toContain(
      `missing front matter key: ${key}`,
    );
  });

  it.each(["from", "topic"])("rejects an empty %s", (key) => {
    expect(errors(parseMessageFile(PATH, file({ [key]: "" })))).toContain(`${key} is empty`);
  });

  it.each([",", ", ,"])("rejects malformed empty recipient list %j", (to) => {
    expect(errors(parseMessageFile(PATH, file({ to })))).toContain("to is empty");
  });

  it("rejects an id that does not follow the id pattern", () => {
    expect(errors(parseMessageFile(PATH, file({ id: "hello" })))).toContain(
      "id must look like YYYY-MM-DDTHHMM-<from>-<topic>-<NN>: hello",
    );
  });

  it("keeps the raw text of a malformed file", () => {
    const raw = "not a message";
    expect(parseMessageFile(PATH, raw)).toEqual({
      kind: "malformed",
      path: PATH,
      errors: ["front matter must start with a '---' line"],
      raw,
    });
  });
});

describe("parseMessageFile: non-fatal problems are reported as issues", () => {
  const cases: [string, Record<string, string | null>, string][] = [
    ["an unknown key", { extra: "1" }, "unknown front matter key: extra"],
    ["a missing type", { type: null }, "missing front matter key: type"],
    ["a missing needs", { needs: null }, "missing front matter key: needs"],
    ["a missing optional key", { due: null }, "missing front matter key: due"],
    ["an unknown type", { type: "chat" }, "unknown type: chat"],
    ["an answer without reply_to", { type: "answer" }, "type answer needs reply_to"],
    ["an ack without reply_to", { type: "ack" }, "type ack needs reply_to"],
    ["an invalid reply_to", { reply_to: "earlier" }, "reply_to is not a message id: earlier"],
    ["an empty needs", { needs: "" }, "needs is empty (use none when nothing is requested)"],
    ["an invalid due", { due: "2026-02-30" }, "due must be a YYYY-MM-DD date: 2026-02-30"],
    ["an invalid sender name", { from: "Alice" }, "from must be lowercase [a-z0-9-]: Alice"],
    ["an invalid recipient", { to: "bob-agent, Bob" }, "to entry must be lowercase [a-z0-9-]: Bob"],
    [
      "an id that disagrees with from and topic",
      { from: "bob-agent" },
      `id does not match from=bob-agent topic=api: ${ID}`,
    ],
    [
      "an impossible id timestamp",
      { id: "2026-13-08T0905-alice-agent-api-01" },
      "id timestamp is not a valid date and time: 2026-13-08T0905",
    ],
    [
      "sequence number 00",
      { id: "2026-10-08T0905-alice-agent-api-00" },
      "id sequence NN starts at 01",
    ],
  ];

  it.each(cases)("reports %s", (_name, overrides, expected) => {
    const id = overrides.id ?? ID;
    const result = message(parseMessageFile(`inbox/${id.slice(0, 7)}/${id}.md`, file(overrides)));
    expect(result.issues).toContain(expected);
  });

  it("reports an unknown type and keeps it out of the typed field", () => {
    expect(message(parseMessageFile(PATH, file({ type: "chat" }))).type).toBeNull();
  });

  it("reports a file name that differs from the id", () => {
    const result = message(parseMessageFile("inbox/2026-10/other.md", file()));
    expect(result.issues).toContain(`file name does not match id: other.md`);
  });

  it("reports a month folder that differs from the id month", () => {
    const result = message(parseMessageFile(`inbox/2026-09/${ID}.md`, file()));
    expect(result.issues).toContain("month folder 2026-09 does not match id month 2026-10");
  });

  it("reports an empty body", () => {
    const result = message(parseMessageFile(PATH, file({}, "")));
    expect(result.issues).toContain("body is empty");
    expect(result.body).toEqual({ state: "plain", lines: [] });
  });

  it("reports more than five body lines but keeps them all", () => {
    const body = ["1", "2", "3", "4", "5", "6"].join("\n");
    const result = message(parseMessageFile(PATH, file({}, body)));
    expect(result.issues).toContain(
      "body has 6 lines; at most 5 (long content belongs in topics/)",
    );
    expect(result.body).toEqual({ state: "plain", lines: ["1", "2", "3", "4", "5", "6"] });
  });
});

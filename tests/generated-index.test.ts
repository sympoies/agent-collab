import { describe, expect, it } from "vitest";

import {
  MAX_GENERATED_BYTES,
  MAX_GENERATED_ROWS,
  parseId,
  parseTopicIndex,
  parseTopicOpen,
  plainText,
  readTables,
  rowAgrees,
  topicMessagePathFor,
} from "../src/message/generated-index";

const HEADER =
  "| id | from | to | type | topic | reply_to | needs | 摘要 |\n|---|---|---|---|---|---|---|---|";
const row = (id: string, from = "alice-agent", topic = "api", to = "bob-agent") =>
  `| ${id} | ${from} | ${to} | info | ${topic} |  | none | hello |`;
const ID = (n: number, topic = "api") =>
  `2026-11-${String(1 + (n % 28)).padStart(2, "0")}T09${String(n % 60).padStart(2, "0")}-alice-agent-${topic}-01`;
const index = (rows: string[]) => ["# index", "", HEADER, ...rows].join("\n");

describe("plain text of untrusted cells", () => {
  it("drops hidden characters, bidi overrides and links, and collapses space", () => {
    expect(plainText("a\u0007b‮c​d⁦e")).toBe("abcde");
    expect(plainText("  two   spaces\tand\nnewline ")).toBe("two spaces and newline");
    expect(plainText("[label](javascript:alert(1))")).toBe("label");
    expect(plainText("x".repeat(500))).toHaveLength(200);
    expect(plainText("x".repeat(500), 10)).toHaveLength(10);
  });
});

describe("message ids and the only path a row can become", () => {
  it("parses a valid id and refuses every malformed one", () => {
    expect(parseId(ID(1))?.month).toBe("2026-11");
    for (const bad of [
      "",
      "../../etc/passwd",
      "2026-13-01T0900-alice-agent-api-01",
      "2026-02-30T0900-alice-agent-api-01",
      "2026-11-01T2500-alice-agent-api-01",
      "2026-11-01T0960-alice-agent-api-01",
      "2026-11-01T0900-alice-agent-api-00",
      "2026-11-01T0900-Alice-api-01",
      "2026-11-01T0900-alice/agent-api-01",
      `${ID(1)}/../x`,
    ]) {
      expect(parseId(bad), bad).toBeNull();
    }
  });

  it("builds a message path only from validated parts, inside topics/<topic>/inbox/", () => {
    expect(topicMessagePathFor("api", ID(1))).toBe(`topics/api/inbox/2026-11/${ID(1)}.md`);
    expect(topicMessagePathFor("api", ID(1, "ops"))).toBeNull();
    expect(topicMessagePathFor("a--b", ID(1, "a--b"))).toBeNull();
    expect(topicMessagePathFor("../x", ID(1))).toBeNull();
    expect(topicMessagePathFor("api", "2026-11-01T0900-api-01")).toBeNull();
    for (const hostile of [
      "../../.agent-collab",
      "topics/ops/inbox/2026-11/x",
      "2026-11-01T0900-alice-agent-api-01.md/../../x",
      "2026-11-01T0900-alice-agent-api-01\n2026-11-01T0900-alice-agent-api-02",
    ]) {
      expect(topicMessagePathFor("api", hostile), hostile).toBeNull();
    }
  });
});

describe("the tables of a generated file", () => {
  it("reads headings, headers and rows, and ignores prose and half tables", () => {
    const { tables, truncated } = readTables(
      [
        "# t",
        "text",
        "## Unanswered",
        "| id | from |",
        "|---|---|",
        "| a | b |",
        "",
        "| x | y |",
        "| not | a table |",
      ].join("\n"),
    );
    expect(truncated).toBe(false);
    expect(tables).toEqual([{ heading: "Unanswered", header: ["id", "from"], rows: [["a", "b"]] }]);
  });

  it("reads nothing from an oversized file, ignores long lines and caps rows and cells", () => {
    expect(readTables("x".repeat(MAX_GENERATED_BYTES + 1)).tables).toEqual([]);
    const long = `| id |\n|---|\n| ${"y".repeat(5000)} |\n| ok |`;
    expect(readTables(long).tables[0]?.rows).toEqual([["ok"]]);
    const many = [
      "| id |",
      "|---|",
      ...Array.from({ length: MAX_GENERATED_ROWS + 10 }, () => "| a |"),
    ];
    const capped = readTables(many.join("\n"));
    expect(capped.truncated).toBe(true);
    expect(capped.tables[0]?.rows).toHaveLength(MAX_GENERATED_ROWS);
    const wide = `| ${Array.from({ length: 200 }, (_, i) => `c${String(i)}`).join(" | ")} |\n|---|\n| ${Array.from({ length: 200 }, () => "v").join(" | ")} |`;
    expect(readTables(wide).tables[0]?.header).toHaveLength(24);
  });
});

describe("the per-topic index", () => {
  it("reads the count and the newest id, in id order, ignoring other columns", () => {
    const parsed = parseTopicIndex(index([row(ID(3)), row(ID(1)), row(ID(2))]), "api");
    expect(parsed.count).toBe(3);
    expect(parsed.newestId).toBe([ID(1), ID(2), ID(3)].sort().at(-1));
    expect(parsed.rows.map((r) => r.id)).toEqual([ID(1), ID(2), ID(3)].sort());
    expect(parsed.rows[0]).toMatchObject({ from: "alice-agent", to: ["bob-agent"], type: "info" });
  });

  it("drops hostile rows: another topic, a mismatched sender, a bad id, a duplicate", () => {
    const parsed = parseTopicIndex(
      index([
        row(ID(1)),
        row(ID(1)),
        row(ID(2, "ops"), "alice-agent", "ops"),
        row(ID(3), "bob-agent"),
        row(ID(4), "alice-agent", "ops"),
        row("../../x"),
        row(ID(5), "Alice"),
        row(ID(6)),
      ]),
      "api",
    );
    expect(parsed.rows.map((r) => r.id)).toEqual([ID(1), ID(6)].sort());
    // A file with any bad row is not believed about the count either.
    expect(parsed).toMatchObject({ count: null, newestId: null });
  });

  it("is untrusted text only: no markup survives, names are filtered", () => {
    const hostile = `| ${ID(1)} | alice-agent | bob-agent, <img src=x onerror=1>, ../x | <script>alert(1)</script> | api |  | [a](javascript:x) | s |`;
    const parsed = parseTopicIndex(index([hostile]), "api");
    expect(parsed.rows[0]).toMatchObject({ to: ["bob-agent"], type: "<script>alert(1)</script>" });
    expect(parsed.rows[0]?.needs).toBe("a");
  });

  it("says nothing about the count when the file is cut short, empty, headerless or oversized", () => {
    const rows = Array.from({ length: MAX_GENERATED_ROWS + 5 }, (_, i) => row(ID(i)));
    const cut = parseTopicIndex(index(rows), "api");
    expect(cut).toMatchObject({ truncated: true, count: null, newestId: null });
    expect(parseTopicIndex("", "api")).toMatchObject({ count: null, rows: [] });
    expect(parseTopicIndex("| a | b |\n|---|---|\n| 1 | 2 |", "api").rows).toEqual([]);
    expect(parseTopicIndex("x".repeat(MAX_GENERATED_BYTES + 1), "api").count).toBeNull();
    expect(parseTopicIndex(index([row(ID(1))]), "../x").count).toBeNull();
  });

  it("reads the same from a file with a BOM, CRLF line endings and a BOM inside a cell", () => {
    const lf = index([row(ID(1)), row(ID(2)), row(ID(3))]);
    const expected = parseTopicIndex(lf, "api");
    const crlf = `\uFEFF${lf.replace(/\n/g, "\r\n")}`;
    expect(parseTopicIndex(crlf, "api")).toEqual(expected);
    const inCell = lf.replace(ID(2), `\uFEFF${ID(2)}\u061c`);
    expect(parseTopicIndex(inCell, "api")).toEqual(expected);
    expect(expected).toMatchObject({ count: 3 });
  });

  it("an empty index is zero messages, not unknown", () => {
    expect(parseTopicIndex(index([]), "api")).toMatchObject({ count: 0, newestId: null });
  });
});

describe("the per-topic open file", () => {
  const open = (sections: Record<string, string[]>) =>
    Object.entries(sections)
      .map(([title, rows]) =>
        [
          `## ${title}`,
          "",
          "| id | from | to | needs | due | 摘要 |",
          "|---|---|---|---|---|---|",
          ...rows,
          "",
        ].join("\n"),
      )
      .join("\n");
  const line = (id: string, from = "alice-agent", to = "bob-agent") =>
    `| ${id} | ${from} | ${to} | answer by friday | 2026-11-10 | s |`;

  it("lists the items with their section, validated like the index", () => {
    const items = parseTopicOpen(
      open({
        "Unanswered questions": [line(ID(1)), line(ID(1)), line("../../x"), line(ID(2, "ops"))],
        Overdue: [line(ID(1))],
      }),
      "api",
    );
    expect(items.map((item) => [item.section, item.id, item.to])).toEqual([
      ["Unanswered questions", ID(1), ["bob-agent"]],
      ["Overdue", ID(1), ["bob-agent"]],
    ]);
    expect(parseTopicOpen("", "api")).toEqual([]);
    expect(parseTopicOpen(open({ S: [line(ID(1))] }), "../x")).toEqual([]);
  });
});

describe("verifying a row against its message", () => {
  const rowOf = { id: ID(1), from: "alice-agent", to: [], type: "info", needs: "" } as const;
  it("a row is only as good as the message it names", () => {
    expect(rowAgrees(rowOf, { id: ID(1), from: "alice-agent", topic: "api" }, "api")).toBe(true);
    expect(rowAgrees(rowOf, { id: ID(1), from: "bob-agent", topic: "api" }, "api")).toBe(false);
    expect(rowAgrees(rowOf, { id: ID(1), from: "alice-agent", topic: "ops" }, "api")).toBe(false);
    expect(rowAgrees(rowOf, { id: ID(2), from: "alice-agent", topic: "api" }, "api")).toBe(false);
  });
});

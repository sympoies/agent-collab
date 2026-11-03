import { describe, expect, it } from "vitest";

import { parseCsv } from "../src/message/csv";

describe("parseCsv", () => {
  it("parses a header and rows, with quoted fields, escaped quotes and CRLF", () => {
    const text = 'name,note\r\nalice,"hello, world"\r\nbob,"say ""hi"""\r\n';
    expect(parseCsv(text, ",", 10)).toEqual({
      header: ["name", "note"],
      rows: [
        ["alice", "hello, world"],
        ["bob", 'say "hi"'],
      ],
      totalRows: 2,
      truncated: false,
    });
  });

  it("keeps a newline inside a quoted field in one cell", () => {
    expect(parseCsv('a,b\n"x\ny",z', ",", 10).rows).toEqual([["x\ny", "z"]]);
  });

  it("supports tab-separated text", () => {
    expect(parseCsv("a\tb\n1\t2", "\t", 10).rows).toEqual([["1", "2"]]);
  });

  it("caps the rows and reports the full count", () => {
    const text = ["h", ...Array.from({ length: 30 }, (_, i) => String(i))].join("\n");
    const parsed = parseCsv(text, ",", 5);
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.totalRows).toBe(30);
    expect(parsed.truncated).toBe(true);
  });

  it("returns an empty table for empty text", () => {
    expect(parseCsv("", ",", 5)).toEqual({ header: [], rows: [], totalRows: 0, truncated: false });
  });
});

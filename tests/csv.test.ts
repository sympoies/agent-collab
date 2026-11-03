import { describe, expect, it } from "vitest";

import { parseCsv } from "../src/message/csv";

describe("parseCsv", () => {
  it("parses a header and rows, with quoted fields, escaped quotes and CRLF", () => {
    const text = 'name,note\r\nalice,"hello, world"\r\nbob,"say ""hi"""\r\n';
    expect(parseCsv(text, ",", 10, 50)).toEqual({
      header: ["name", "note"],
      rows: [
        ["alice", "hello, world"],
        ["bob", 'say "hi"'],
      ],
      totalRows: 2,
      truncated: false,
      totalColumns: 2,
      columnsTruncated: false,
    });
  });

  it("keeps a newline inside a quoted field in one cell", () => {
    expect(parseCsv('a,b\n"x\ny",z', ",", 10, 50).rows).toEqual([["x\ny", "z"]]);
  });

  it("supports tab-separated text", () => {
    expect(parseCsv("a\tb\n1\t2", "\t", 10, 50).rows).toEqual([["1", "2"]]);
  });

  it("caps the rows and reports the full count", () => {
    const text = ["h", ...Array.from({ length: 30 }, (_, i) => String(i))].join("\n");
    const parsed = parseCsv(text, ",", 5, 50);
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.totalRows).toBe(30);
    expect(parsed.truncated).toBe(true);
  });

  it("returns an empty table for empty text", () => {
    expect(parseCsv("", ",", 5, 50)).toEqual({
      header: [],
      rows: [],
      totalRows: 0,
      truncated: false,
      totalColumns: 0,
      columnsTruncated: false,
    });
  });

  it("strips a byte order mark so the first header is clean", () => {
    expect(parseCsv("\uFEFFname,note\nalice,x", ",", 5, 50).header).toEqual(["name", "note"]);
  });

  it("keeps ragged rows as they are", () => {
    expect(parseCsv("a,b,c\n1\n1,2,3,4", ",", 5, 50).rows).toEqual([["1"], ["1", "2", "3", "4"]]);
  });

  it("handles a header-only file and a file of newlines only", () => {
    expect(parseCsv("a,b\n", ",", 5, 50)).toMatchObject({
      header: ["a", "b"],
      rows: [],
      totalRows: 0,
    });
    expect(parseCsv("\n\n\r\n", ",", 5, 50)).toMatchObject({ header: [], rows: [], totalRows: 0 });
  });

  it("caps the columns of the header and of every row and reports the full width", () => {
    const wide = Array.from({ length: 80 }, (_, i) => `c${String(i)}`).join(",");
    const parsed = parseCsv(`${wide}\n${wide}`, ",", 5, 50);
    expect(parsed.header).toHaveLength(50);
    expect(parsed.rows[0]).toHaveLength(50);
    expect(parsed.totalColumns).toBe(80);
    expect(parsed.columnsTruncated).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import type { TimelineItem } from "../src/loader/loader";
import { parseMessageFile } from "../src/message/parse";
import { buildRows, topicSummaries, type Row } from "../src/ui/timeline";
import { messageText } from "./support";

function item(
  stamp: string,
  from: string,
  topic: string,
  fields: Record<string, string> = {},
): TimelineItem {
  const id = `${stamp}-${from}-${topic}-01`;
  return parseMessageFile(`inbox/${id}.md`, messageText(id, from, topic, fields));
}

const OPTIONS = {
  selfNames: new Set<string>(),
  topic: null,
  today: "2026-10-05",
  fresh: new Set<string>(),
};

function shape(rows: readonly Row[]): string[] {
  return rows.map((row) => {
    switch (row.kind) {
      case "day":
        return `day ${row.date}`;
      case "group":
        return `${row.align} ${row.from}/${row.topic} x${row.messages.length}`;
      default:
        return row.kind;
    }
  });
}

describe("buildRows", () => {
  it("groups consecutive messages from one sender and topic within ten minutes", () => {
    const rows = buildRows(
      [
        item("2026-10-01T0900", "alice-agent", "api"),
        item("2026-10-01T0909", "alice-agent", "api"),
        item("2026-10-01T0920", "alice-agent", "api"),
        item("2026-10-01T0921", "alice-agent", "ops"),
        item("2026-10-01T0922", "bob-agent", "ops"),
      ],
      OPTIONS,
    );
    expect(shape(rows)).toEqual([
      "day 2026-10-01",
      "start alice-agent/api x2",
      "start alice-agent/api x1",
      "start alice-agent/ops x1",
      "start bob-agent/ops x1",
    ]);
  });

  it("starts a new group and a day separator when the date changes", () => {
    const rows = buildRows(
      [
        item("2026-10-01T2358", "alice-agent", "api"),
        item("2026-10-02T0001", "alice-agent", "api"),
      ],
      OPTIONS,
    );
    expect(shape(rows)).toEqual([
      "day 2026-10-01",
      "start alice-agent/api x1",
      "day 2026-10-02",
      "start alice-agent/api x1",
    ]);
  });

  it("aligns messages from my names to the end", () => {
    const rows = buildRows(
      [item("2026-10-01T0900", "alice-agent", "api"), item("2026-10-01T0901", "bob-agent", "api")],
      { ...OPTIONS, selfNames: new Set(["bob-agent"]) },
    );
    expect(shape(rows)).toEqual([
      "day 2026-10-01",
      "start alice-agent/api x1",
      "end bob-agent/api x1",
    ]);
  });

  it("filters by topic and hides files without a known topic", () => {
    const malformed: TimelineItem = {
      kind: "malformed",
      path: "inbox/x.md",
      errors: ["e"],
      raw: "",
    };
    const unavailable: TimelineItem = {
      kind: "unavailable",
      path: "inbox/y.md",
      error: "unexpected",
    };
    const items = [
      item("2026-10-01T0900", "alice-agent", "api"),
      malformed,
      unavailable,
      item("2026-10-01T0901", "alice-agent", "ops"),
    ];
    expect(shape(buildRows(items, OPTIONS))).toEqual([
      "day 2026-10-01",
      "start alice-agent/api x1",
      "malformed",
      "unavailable",
      "start alice-agent/ops x1",
    ]);
    expect(shape(buildRows(items, { ...OPTIONS, topic: "ops" }))).toEqual([
      "day 2026-10-01",
      "start alice-agent/ops x1",
    ]);
  });

  it("resolves the parent of a reply when it is loaded", () => {
    const parentId = "2026-10-01T0900-alice-agent-api-01";
    const rows = buildRows(
      [
        item("2026-10-01T0900", "alice-agent", "api", { type: "question" }),
        item("2026-10-01T0905", "bob-agent", "api", { type: "answer", reply_to: parentId }),
        item("2026-10-01T0906", "bob-agent", "api", {
          type: "answer",
          reply_to: "2026-09-01T0900-alice-agent-api-01",
        }),
      ],
      OPTIONS,
    );
    const replies = rows.flatMap((row) => (row.kind === "group" ? row.messages : [])).slice(1);
    expect(replies.map((view) => view.parent?.id ?? null)).toEqual([parentId, null]);
  });

  it("does not resolve a loaded reply parent when the topic filter hides it", () => {
    const parentId = "2026-10-01T0900-alice-agent-api-01";
    const rows = buildRows(
      [
        item("2026-10-01T0900", "alice-agent", "api", { type: "question" }),
        item("2026-10-01T0905", "bob-agent", "ops", { type: "answer", reply_to: parentId }),
      ],
      { ...OPTIONS, topic: "ops" },
    );
    const reply = rows.flatMap((row) => (row.kind === "group" ? row.messages : []))[0];
    expect(reply?.parent).toBeNull();
  });

  it("marks a request overdue only while no answer replies to it", () => {
    const open = "2026-10-01T0900-alice-agent-api-01";
    const rows = buildRows(
      [
        item("2026-10-01T0900", "alice-agent", "api", { type: "question", due: "2026-10-04" }),
        item("2026-10-01T0901", "alice-agent", "ops", { type: "question", due: "2026-10-04" }),
        item("2026-10-01T0902", "alice-agent", "web", { type: "question", due: "2026-10-05" }),
        item("2026-10-01T0903", "bob-agent", "api", { type: "ack", reply_to: open }),
        item("2026-10-01T0904", "bob-agent", "ops", {
          type: "answer",
          reply_to: "2026-10-01T0901-alice-agent-ops-01",
        }),
      ],
      OPTIONS,
    );
    const overdue = rows.flatMap((row) =>
      row.kind === "group"
        ? row.messages.filter((view) => view.overdue).map((view) => view.message.id)
        : [],
    );
    expect(overdue).toEqual([open]);
  });

  it("starts a new sender group at the unread boundary", () => {
    const fresh = item("2026-10-01T0901", "alice-agent", "api");
    const rows = buildRows([item("2026-10-01T0900", "alice-agent", "api"), fresh], {
      ...OPTIONS,
      fresh: new Set([fresh.kind === "message" ? fresh.message.path : ""]),
    });
    const groups = rows.filter((row) => row.kind === "group");
    expect(groups.map((row) => row.messages.map((view) => view.fresh))).toEqual([[false], [true]]);
  });

  it("keys groups by file path so two files with one id stay distinct", () => {
    const id = "2026-10-01T0900-alice-agent-api-01";
    const rows = buildRows(
      [
        parseMessageFile(`inbox/${id}.md`, messageText(id, "alice-agent", "api")),
        parseMessageFile(
          `inbox/2026-10/${id}.md`,
          messageText(id, "alice-agent", "api", { from: "bob-agent" }),
        ),
      ],
      OPTIONS,
    );
    const keys = rows.flatMap((row) => (row.kind === "group" ? [row.key] : []));
    expect(keys).toEqual([`inbox/${id}.md`, `inbox/2026-10/${id}.md`]);
  });
});

describe("topicSummaries", () => {
  it("lists topics by most recent activity with total and fresh counts", () => {
    const newest = item("2026-10-02T0900", "bob-agent", "api");
    const items = [
      item("2026-10-01T0900", "alice-agent", "api"),
      item("2026-10-01T0930", "alice-agent", "ops"),
      newest,
    ];
    const fresh = new Set([newest.kind === "message" ? newest.message.path : ""]);
    expect(topicSummaries(items, fresh)).toEqual([
      { topic: "api", count: 2, fresh: 1 },
      { topic: "ops", count: 1, fresh: 0 },
    ]);
  });
});

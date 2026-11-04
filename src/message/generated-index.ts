// Readers for the generated files of a topic (`index.md`, `open.md`): a fast path for counts and
// open items, never the record (docs/design/topics-and-scale.md, sections 6.2 and 6.5). Everything
// in these files is untrusted text: a file over the size cap is not parsed, rows and cells are
// capped, every cell is reduced to plain text, an id must follow the id grammar and agree with the
// topic and the sender in the same row, and nothing here ever builds a path from a cell except
// through `topicMessagePathFor`, which refuses anything outside `topics/<topic>/inbox/`.

import { plainText } from "./plain-text";
import { isTopicFolderName } from "./topic-layout";

export { plainText };

/** A generated file larger than this is ignored and the listing is used instead. */
export const MAX_GENERATED_BYTES = 2 * 1024 * 1024;
/** Rows read from one generated file; more mark the result as truncated. */
export const MAX_GENERATED_ROWS = 5000;
/** A line longer than this is ignored whole (a row is never this long). */
const MAX_LINE = 4000;
const MAX_CELLS = 24;

export interface Table {
  /** The nearest `##` heading above the table, as plain text. */
  readonly heading: string;
  /** Column names, lower case. */
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface ReadTables {
  readonly tables: readonly Table[];
  /** True when the row cap stopped the reading. */
  readonly truncated: boolean;
}

function cellsOf(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const parts = trimmed.split("|");
  // A leading and a trailing pipe leave an empty first and last part.
  return parts
    .slice(1, trimmed.endsWith("|") ? -1 : undefined)
    .slice(0, MAX_CELLS)
    .map((cell) => plainText(cell));
}

/**
 * Reads the markdown tables of a generated file. A table is a header row followed by a separator
 * row; the rows after it are its data. Oversized input and over-long lines yield nothing for the
 * part concerned, and at most `MAX_GENERATED_ROWS` data rows are read in all.
 */
export function readTables(text: string): ReadTables {
  if (text.length > MAX_GENERATED_BYTES) return { tables: [], truncated: false };
  const tables: { heading: string; header: string[]; rows: string[][] }[] = [];
  let heading = "";
  let current: (typeof tables)[number] | null = null;
  let pendingHeader: string[] | null = null;
  let count = 0;
  let truncated = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.length > MAX_LINE) continue;
    const title = /^##\s+(.*)$/.exec(line);
    if (title !== null) {
      heading = plainText(title[1] ?? "", 80);
      current = null;
      pendingHeader = null;
      continue;
    }
    const cells = cellsOf(line);
    if (cells === null) {
      current = null;
      pendingHeader = null;
      continue;
    }
    if (current !== null) {
      if (count >= MAX_GENERATED_ROWS) {
        truncated = true;
        break;
      }
      count += 1;
      current.rows.push(cells);
    } else if (pendingHeader !== null) {
      // The row after a header must be the separator; otherwise it was not a table.
      if (cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell))) {
        current = { heading, header: pendingHeader.map((cell) => cell.toLowerCase()), rows: [] };
        tables.push(current);
      }
      pendingHeader = null;
    } else {
      pendingHeader = cells;
    }
  }
  return { tables, truncated };
}

const NAME_RE = /^[a-z0-9-]+$/;
const ID_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})-([a-z0-9-]+)-(\d{2})$/;

/** The parts of a message id, or null when it does not follow the grammar. */
export function parseId(
  id: string,
): { month: string; senderAndTopic: string; sequence: string } | null {
  const match = ID_RE.exec(id);
  if (match === null) return null;
  const [, year, month, day, hour, minute, senderAndTopic, sequence] = match.map(String);
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    sequence === "00"
  ) {
    return null;
  }
  return {
    month: `${String(year)}-${String(month)}`,
    senderAndTopic: String(senderAndTopic),
    sequence: String(sequence),
  };
}

/**
 * The path of a message of `topic`, or null for anything that is not one: the only way a row of a
 * generated file turns into a request. The path is built from validated parts, never copied.
 */
export function topicMessagePathFor(topic: string, id: string): string | null {
  if (!isTopicFolderName(topic)) return null;
  const parts = parseId(id);
  if (parts === null || !parts.senderAndTopic.endsWith(`-${topic}`)) return null;
  const from = parts.senderAndTopic.slice(0, -`-${topic}`.length);
  if (!NAME_RE.test(from) || from === "") return null;
  return `topics/${topic}/inbox/${parts.month}/${id}.md`;
}

function names(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => NAME_RE.test(name))
    .slice(0, 50);
}

/** One message as a generated file claims it; the message file is what is true. */
export interface IndexRow {
  readonly id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly type: string;
  readonly needs: string;
}

export interface TopicIndex {
  /** Rows read, newest last; duplicates and rows that fail the checks are dropped. */
  readonly rows: readonly IndexRow[];
  /**
   * The number of messages the file claims; null when it was cut short or unreadable, or when any
   * row failed the checks (a file that lies in one row is not believed in another).
   */
  readonly count: number | null;
  /** The newest id among the rows; null when none, or when the file was cut short. */
  readonly newestId: string | null;
  readonly truncated: boolean;
}

/** A row's id must agree with its sender and the topic being read, or the row is dropped. */
function rowIdFor(topic: string, id: string, from: string): string | null {
  return topicMessagePathFor(topic, id) !== null &&
    parseId(id)?.senderAndTopic === `${from}-${topic}`
    ? id
    : null;
}

/**
 * The per-topic `index.md`: one row per message (id, from, to, type, topic, reply_to, needs,
 * summary). Used for the message count and the newest id of a topic; unknown columns are ignored.
 */
export function parseTopicIndex(text: string, topic: string): TopicIndex {
  const { tables, truncated } = readTables(text);
  const table = tables.find((candidate) => candidate.header.includes("id"));
  const empty: TopicIndex = { rows: [], count: null, newestId: null, truncated };
  if (table === undefined || !isTopicFolderName(topic)) return empty;
  const column = (name: string) => table.header.indexOf(name);
  const [iId, iFrom, iTo, iType, iTopic, iNeeds] = [
    "id",
    "from",
    "to",
    "type",
    "topic",
    "needs",
  ].map(column) as [number, number, number, number, number, number];
  if (iId === -1 || iFrom === -1) return empty;
  const seen = new Set<string>();
  const rows: IndexRow[] = [];
  let dropped = 0;
  for (const cells of table.rows) {
    const from = cells[iFrom] ?? "";
    const id = rowIdFor(topic, cells[iId] ?? "", from);
    // A topic column, when present, must name this topic.
    if (id === null || seen.has(id) || (iTopic !== -1 && (cells[iTopic] ?? "") !== topic)) {
      dropped += 1;
      continue;
    }
    seen.add(id);
    rows.push({
      id,
      from,
      to: iTo === -1 ? [] : names(cells[iTo] ?? ""),
      type: iType === -1 ? "" : (cells[iType] ?? "").slice(0, 40),
      needs: iNeeds === -1 ? "" : (cells[iNeeds] ?? "").slice(0, 80),
    });
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // A file with any row that fails the checks is not trusted for a count or a newest id.
  const trusted = !truncated && dropped === 0;
  return {
    rows,
    count: trusted ? rows.length : null,
    newestId: trusted ? (rows.at(-1)?.id ?? null) : null,
    truncated,
  };
}

export interface OpenItem extends IndexRow {
  /** The section of the file the row is in (plain text), for example "Unanswered questions". */
  readonly section: string;
}

/**
 * The per-topic `open.md`: sections of rows (id, from, to, needs, due, summary). The rows are the
 * viewer's first look at what is waiting; opening one loads the message, whose own front matter
 * decides.
 */
export function parseTopicOpen(text: string, topic: string): readonly OpenItem[] {
  if (!isTopicFolderName(topic)) return [];
  const items: OpenItem[] = [];
  const seen = new Set<string>();
  for (const table of readTables(text).tables) {
    const iId = table.header.indexOf("id");
    const iFrom = table.header.indexOf("from");
    const iTo = table.header.indexOf("to");
    const iNeeds = table.header.indexOf("needs");
    if (iId === -1 || iFrom === -1) continue;
    for (const cells of table.rows) {
      const from = cells[iFrom] ?? "";
      const id = rowIdFor(topic, cells[iId] ?? "", from);
      const key = `${table.heading}\0${String(id)}`;
      if (id === null || seen.has(key)) continue;
      seen.add(key);
      items.push({
        id,
        from,
        to: iTo === -1 ? [] : names(cells[iTo] ?? ""),
        type: "",
        needs: iNeeds === -1 ? "" : (cells[iNeeds] ?? "").slice(0, 80),
        section: table.heading,
      });
    }
  }
  return items;
}

/** Whether a row agrees with the message it names; when it does not, the message wins. */
export function rowAgrees(
  row: IndexRow,
  message: { readonly id: string; readonly from: string; readonly topic: string },
  topic: string,
): boolean {
  return message.id === row.id && message.from === row.from && message.topic === topic;
}

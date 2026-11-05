// The topic folder layout (docs/design/topics-and-scale.md, section 4): grammar, the marker value,
// TOPIC.md and the root topic index. Pure: parsers never throw on file content, and everything
// read from a generated file is treated as untrusted text.

import { plainText } from "./plain-text";

/** A topic folder name: lowercase letters and digits with single hyphens between parts. */
const TOPIC_FOLDER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Names that cannot be topic folders: they are reserved inside `topics/<topic>/`. */
const RESERVED_TOPIC_NAMES: ReadonlySet<string> = new Set(["inbox", "index", "open"]);
/** The topic a message may carry in its front matter (older, looser rule, still valid). */
const MESSAGE_TOPIC_RE = /^[a-z0-9-]+$/;

/** Generated files are only a fast path: a larger one is ignored and the listing is used. */
export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
/** Rows read from the root index; more are ignored. */
export const MAX_INDEX_ROWS = 5000;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 200;

export function isTopicFolderName(name: string): boolean {
  return TOPIC_FOLDER_RE.test(name) && !RESERVED_TOPIC_NAMES.has(name);
}

/** The value of `inbox-layout` in the marker, `flat` when the line is absent. */
export function markerLayout(markerText: string): string {
  for (const line of markerText
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(1)) {
    const colon = line.indexOf(":");
    if (colon !== -1 && line.slice(0, colon).trim() === "inbox-layout") {
      return line.slice(colon + 1).trim();
    }
  }
  return "flat";
}

export interface MarkerParticipants {
  readonly participants: readonly string[];
  readonly formerParticipants: readonly string[];
}

/** Participant names from the marker, shared by topic-list and message loaders. */
export function markerParticipants(markerText: string): MarkerParticipants {
  const fields = new Map<string, string>();
  for (const line of markerText
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key === "participants" || key === "former-participants") {
      fields.set(key, line.slice(colon + 1).trim());
    }
  }
  const split = (value: string | undefined): string[] =>
    value === undefined
      ? []
      : value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
  return {
    participants: split(fields.get("participants")),
    formerParticipants: split(fields.get("former-participants")),
  };
}

/** Layouts this viewer reads. */
export function isKnownLayout(layout: string): boolean {
  return layout === "flat" || layout === "monthly" || layout === "topic";
}

/** `topics/<topic>/inbox/YYYY-MM/<file>` split into its parts, or null for any other path. */
export function topicMessagePath(path: string): { topic: string; month: string } | null {
  const match = /^topics\/([^/]+)\/inbox\/(\d{4}-\d{2})\/[^/]+$/.exec(path);
  return match === null ? null : { topic: match[1] as string, month: match[2] as string };
}

export type TopicStatus = "open" | "closed" | "legacy";

/** What the viewer knows about one topic before reading any of its messages. */
export interface TopicSummary {
  readonly name: string;
  readonly title: string | null;
  readonly status: TopicStatus;
  /** True when `topics/<name>/` exists; a legacy-only topic has no folder. */
  readonly folder: boolean;
}

function cellText(value: string, limit: number): string {
  return plainText(value, limit);
}

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = trimmed.split("|").map((cell) => cell.trim());
  // A leading and a trailing pipe produce empty first and last cells.
  return cells.slice(1, trimmed.endsWith("|") ? -1 : undefined);
}

const HEADER_NAMES: Record<"name" | "title" | "status", readonly string[]> = {
  name: ["topic", "name", "主題"],
  title: ["title", "標題"],
  status: ["status", "狀態"],
};

export interface IndexRow {
  readonly name: string;
  readonly title: string | null;
  readonly status: TopicStatus;
}

/**
 * Rows of the root `index.md`, a markdown table with a header naming the columns (topic, title,
 * status; English or Traditional Chinese). Untrusted: a file over the size cap, a missing header
 * or a row without a valid topic name yields nothing for that part, never an error.
 */
export function parseRootIndex(text: string): readonly IndexRow[] {
  if (text.length > MAX_INDEX_BYTES) return [];
  const rows: IndexRow[] = [];
  let columns: { name: number; title: number; status: number } | null = null;
  let seen = 0;
  for (const line of text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const cells = splitRow(line);
    if (cells === null) continue;
    if (columns === null) {
      const lower = cells.map((cell) => cell.toLowerCase());
      const find = (names: readonly string[]) => lower.findIndex((cell) => names.includes(cell));
      const name = find(HEADER_NAMES.name);
      if (name !== -1) {
        columns = { name, title: find(HEADER_NAMES.title), status: find(HEADER_NAMES.status) };
      }
      continue;
    }
    if (cells.every((cell) => /^:?-{1,}:?$/.test(cell))) continue;
    seen += 1;
    if (seen > MAX_INDEX_ROWS) break;
    const name = cellText(cells[columns.name] ?? "", 200);
    if (!MESSAGE_TOPIC_RE.test(name)) continue;
    const title = columns.title === -1 ? "" : cellText(cells[columns.title] ?? "", MAX_TITLE);
    const status = columns.status === -1 ? "" : cellText(cells[columns.status] ?? "", 20);
    rows.push({
      name,
      title: title === "" ? null : title,
      status: status === "closed" || status === "legacy" ? status : "open",
    });
  }
  return rows;
}

export interface TopicFile {
  readonly title: string | null;
  readonly description: string | null;
  readonly status: "open" | "closed";
  readonly closedDigest: string | null;
}

/** `TOPIC.md`: optional front matter; the body is not parsed. Anything unreadable is "open". */
export function parseTopicFile(text: string): TopicFile {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const fields = new Map<string, string>();
  if (lines[0]?.trim() === "---") {
    for (const line of lines.slice(1)) {
      if (line.trim() === "---") break;
      const colon = line.indexOf(":");
      if (colon !== -1) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }
  const title = cellText(fields.get("title") ?? "", MAX_TITLE);
  const description = cellText(fields.get("description") ?? "", MAX_DESCRIPTION);
  const digest = (fields.get("closed-digest") ?? "").toLowerCase();
  return {
    title: title === "" ? null : title,
    description: description === "" ? null : description,
    status: fields.get("status") === "closed" ? "closed" : "open",
    closedDigest: /^[0-9a-f]{64}$/.test(digest) ? digest : null,
  };
}

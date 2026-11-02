// Message file parser (docs/design.md, section 4). Pure: never throws on file content.

import { MESSAGE_TYPES, type Body, type MessageType, type ParsedFile } from "./types";

const FIELDS = [
  "id",
  "from",
  "to",
  "topic",
  "type",
  "reply_to",
  "replies",
  "refs",
  "needs",
  "due",
] as const;
type Field = (typeof FIELDS)[number];

/** Fields without which a message cannot be placed in the timeline or attributed. */
const PLACEMENT_FIELDS = ["id", "from", "to", "topic"] as const;

const NAME_RE = /^[a-z0-9-]+$/;
const ID_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})-([a-z0-9-]+)-(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DIR_RE = /^inbox\/(\d{4}-\d{2})\/[^/]+$/;
const MAX_BODY_LINES = 5;
const AGE_ARMOR_HEADER = "-----BEGIN AGE ENCRYPTED FILE-----";
// The protocol accepts "none" and its CJK equivalent for "nothing requested".
const NONE_NEEDS = new Set(["none", "無"]);

function isField(key: string): key is Field {
  return (FIELDS as readonly string[]).includes(key);
}

function isMessageType(value: string): value is MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(value);
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end);
}

function parseBody(lines: string[], issues: string[], type: MessageType | null): Body {
  const trimmed = trimBlankEdges(lines);
  if (trimmed[0]?.trim() === AGE_ARMOR_HEADER) {
    return { state: "locked", armored: trimmed.join("\n") };
  }
  const nonBlank = trimmed.filter((line) => line.trim() !== "").length;
  if (nonBlank === 0 && type !== "ack") {
    issues.push("body is empty");
  } else if (nonBlank > MAX_BODY_LINES) {
    issues.push(
      `body has ${nonBlank} lines; at most ${MAX_BODY_LINES} (long content belongs in topics/)`,
    );
  }
  return { state: "plain", lines: trimmed };
}

export function parseMessageFile(path: string, raw: string): ParsedFile {
  const malformed = (errors: string[]): ParsedFile => ({ kind: "malformed", path, errors, raw });
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  if (lines[0]?.trim() !== "---") {
    return malformed(["front matter must start with a '---' line"]);
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    return malformed(["front matter is not closed by a '---' line"]);
  }

  const errors: string[] = [];
  const issues: string[] = [];
  const fields = new Map<Field, string>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      errors.push(`front matter line is not 'key: value': ${line}`);
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!isField(key)) {
      issues.push(`unknown front matter key: ${key}`);
    } else if (fields.has(key)) {
      errors.push(`duplicate front matter key: ${key}`);
    } else {
      fields.set(key, value);
    }
  }

  for (const key of PLACEMENT_FIELDS) {
    const value = fields.get(key);
    if (value === undefined) errors.push(`missing front matter key: ${key}`);
    else if ((key !== "to" || (value !== "" && value !== "all")) && splitList(value).length === 0) {
      errors.push(`${key} is empty`);
    }
  }
  const id = fields.get("id") ?? "";
  const idMatch = ID_RE.exec(id);
  if (id !== "" && idMatch === null) {
    errors.push(`id must look like YYYY-MM-DDTHHMM-<from>-<topic>-<NN>: ${id}`);
  }
  if (errors.length > 0 || idMatch === null) {
    return malformed(errors);
  }

  for (const key of FIELDS) {
    if (key === "replies") continue;
    if (!fields.has(key) && !(PLACEMENT_FIELDS as readonly string[]).includes(key)) {
      issues.push(`missing front matter key: ${key}`);
    }
  }
  const get = (key: Field): string => fields.get(key) ?? "";

  const [, year, month, day, hour, minute, senderTopic, sequence] = idMatch.map(String);
  if (
    !isValidDate(Number(year), Number(month), Number(day)) ||
    Number(hour) > 23 ||
    Number(minute) > 59
  ) {
    issues.push(`id timestamp is not a valid date and time: ${id.slice(0, 15)}`);
  }
  const from = get("from");
  const topic = get("topic");
  if (senderTopic !== `${from}-${topic}`) {
    issues.push(`id does not match from=${from} topic=${topic}: ${id}`);
  }
  if (sequence === "00") issues.push("id sequence NN starts at 01");

  const fileName = path.slice(path.lastIndexOf("/") + 1);
  if (fileName !== `${id}.md`) issues.push(`file name does not match id: ${fileName}`);
  const folder = MONTH_DIR_RE.exec(path)?.[1];
  const idMonth = `${year}-${month}`;
  if (folder !== undefined && folder !== idMonth) {
    issues.push(`month folder ${folder} does not match id month ${idMonth}`);
  }

  for (const [key, value] of [
    ["from", from],
    ["topic", topic],
  ] as const) {
    if (!NAME_RE.test(value)) issues.push(`${key} must be lowercase [a-z0-9-]: ${value}`);
  }
  const toValue = get("to");
  const recipients = splitList(toValue);
  const to = toValue === "" || recipients.includes("all") ? [] : recipients;
  for (const name of to) {
    if (!NAME_RE.test(name)) issues.push(`to entry must be lowercase [a-z0-9-]: ${name}`);
  }

  const typeValue = get("type");
  const type = isMessageType(typeValue) ? typeValue : null;
  if (type === null && fields.has("type")) issues.push(`unknown type: ${typeValue}`);

  const replyTo = get("reply_to");
  if (replyTo !== "" && !ID_RE.test(replyTo)) {
    issues.push(`reply_to is not a message id: ${replyTo}`);
  }
  if ((type === "answer" || type === "ack") && replyTo === "") {
    issues.push(`type ${type} needs reply_to`);
  }

  const repliesValue = get("replies");
  let replies: "any" | "all" | number | null = null;
  if (fields.has("replies") && type !== "question") {
    issues.push("replies applies only to question messages");
  } else if (type === "question" && fields.has("replies")) {
    if (repliesValue === "any" || repliesValue === "all") {
      replies = repliesValue;
    } else if (/^[1-9]\d*$/.test(repliesValue) && Number.isSafeInteger(Number(repliesValue))) {
      replies = Number(repliesValue);
    } else {
      issues.push(`replies must be any, all, or a positive integer: ${repliesValue}`);
    }
  }

  const needs = get("needs");
  if (fields.has("needs") && needs === "") {
    issues.push("needs is empty (use none when nothing is requested)");
  }

  const due = get("due");
  const dueMatch = DATE_RE.exec(due);
  if (
    due !== "" &&
    (dueMatch === null ||
      !isValidDate(Number(dueMatch[1]), Number(dueMatch[2]), Number(dueMatch[3])))
  ) {
    issues.push(`due must be a YYYY-MM-DD date: ${due}`);
  }

  const body = parseBody(lines.slice(end + 1), issues, type);

  return {
    kind: "message",
    message: {
      id,
      path,
      timestamp: `${year}-${month}-${day} ${hour}:${minute}`,
      from,
      to,
      topic,
      type,
      replyTo: replyTo === "" ? null : replyTo,
      replies,
      refs: splitList(get("refs")),
      needs: needs === "" || NONE_NEEDS.has(needs.toLowerCase()) ? null : needs,
      due: due === "" ? null : due,
      body,
      issues,
    },
  };
}

// Chat rendering rules (docs/design.md, section 5) as pure functions.

import type { TimelineItem } from "../loader/loader";
import type { MessageReceipts } from "../message/receipts";
import type { Message } from "../message/types";
import type { SourceErrorKind } from "../source/types";

const GROUP_WINDOW_MINUTES = 10;

export interface MessageView {
  readonly message: Message;
  /** The replied-to message when it is loaded. */
  readonly parent: Message | null;
  readonly overdue: boolean;
  readonly fresh: boolean;
  /** Named recipient is the viewer ("Viewing as"); a broadcast does not count. */
  readonly addressed: boolean;
  /** Acknowledgements, recipient states and question progress, when the message has any. */
  readonly receipts: MessageReceipts | null;
}

export type Row =
  | { readonly kind: "day"; readonly date: string }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly from: string;
      readonly topic: string;
      /** Sent by the viewer ("Viewing as"). */
      readonly own: boolean;
      readonly messages: readonly MessageView[];
    }
  | {
      readonly kind: "malformed";
      readonly path: string;
      readonly errors: readonly string[];
      readonly raw: string;
    }
  | { readonly kind: "unavailable"; readonly path: string; readonly error: SourceErrorKind };

export interface RowOptions {
  /** The person the viewer is ("Viewing as"), or null as Observer. */
  readonly viewer: string | null;
  /** Only show this topic; null shows everything. */
  readonly topic: string | null;
  /** Today as YYYY-MM-DD, for overdue checks. */
  readonly today: string;
  /** Paths of messages that arrived after the view opened. */
  readonly fresh: ReadonlySet<string>;
  /** Receipts by message id; acknowledgements shown there are not repeated as rows. */
  readonly receipts?: ReadonlyMap<string, MessageReceipts>;
}

export interface TopicSummary {
  readonly topic: string;
  readonly count: number;
  readonly fresh: number;
}

function minutes(timestamp: string): number {
  const [date = "", time = ""] = timestamp.split(" ");
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) / 60_000 + hour * 60 + minute;
}

export function buildRows(items: readonly TimelineItem[], options: RowOptions): Row[] {
  const messages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
  const byId = new Map(
    messages
      .filter((message) => options.topic === null || message.topic === options.topic)
      .map((message) => [message.id, message]),
  );
  const receipts = options.receipts ?? new Map<string, MessageReceipts>();
  const receiptTargets = new Set(
    messages.filter((message) => message.type !== "ack").map((message) => message.id),
  );
  const answered = new Set(
    messages.flatMap((message) =>
      message.type === "answer" && message.replyTo !== null ? [message.replyTo] : [],
    ),
  );

  const rows: Row[] = [];
  let day: string | null = null;
  let group: {
    from: string;
    topic: string;
    last: number;
    fresh: boolean;
    messages: MessageView[];
  } | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (options.topic === null) {
        rows.push(item);
        group = null;
      }
      continue;
    }
    const message = item.message;
    if (options.topic !== null && message.topic !== options.topic) continue;
    // An acknowledgement is shown as a receipt under the message it answers, not as a row.
    if (message.type === "ack" && message.replyTo !== null && receiptTargets.has(message.replyTo)) {
      continue;
    }

    const date = message.timestamp.slice(0, 10);
    if (date !== day) {
      rows.push({ kind: "day", date });
      day = date;
      group = null;
    }
    const at = minutes(message.timestamp);
    const view: MessageView = {
      message,
      parent: message.replyTo === null ? null : (byId.get(message.replyTo) ?? null),
      overdue:
        message.due !== null &&
        message.due < options.today &&
        message.type !== "answer" &&
        message.type !== "ack" &&
        !answered.has(message.id),
      fresh: options.fresh.has(message.path),
      addressed:
        options.viewer !== null &&
        message.from !== options.viewer &&
        message.to.includes(options.viewer),
      receipts: receipts.get(message.id) ?? null,
    };
    if (
      group !== null &&
      group.from === message.from &&
      group.topic === message.topic &&
      group.fresh === view.fresh &&
      at - group.last <= GROUP_WINDOW_MINUTES
    ) {
      group.messages.push(view);
      group.last = at;
      continue;
    }
    group = {
      from: message.from,
      topic: message.topic,
      last: at,
      fresh: view.fresh,
      messages: [view],
    };
    rows.push({
      kind: "group",
      key: message.path,
      from: message.from,
      topic: message.topic,
      own: message.from === options.viewer,
      messages: group.messages,
    });
  }
  return rows;
}

/** Topics ordered by most recent message, newest first. */
export function topicSummaries(
  items: readonly TimelineItem[],
  fresh: ReadonlySet<string>,
): TopicSummary[] {
  const topics = new Map<string, { count: number; fresh: number; latest: string }>();
  for (const item of items) {
    if (item.kind !== "message") continue;
    const { topic, id, path } = item.message;
    const entry = topics.get(topic) ?? { count: 0, fresh: 0, latest: "" };
    entry.count += 1;
    if (fresh.has(path)) entry.fresh += 1;
    if (id > entry.latest) entry.latest = id;
    topics.set(topic, entry);
  }
  return [...topics.entries()]
    .sort(([, a], [, b]) => (a.latest < b.latest ? 1 : -1))
    .map(([topic, { count, fresh: freshCount }]) => ({ topic, count, fresh: freshCount }));
}

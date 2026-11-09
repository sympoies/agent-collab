// Chat timeline. Message text is always rendered as React text, never as HTML.

import { classes } from "./classes";
import { createContext, Fragment, useContext, type ReactNode } from "react";

import type { MessageReceipts } from "../message/receipts";
import type { Message } from "../message/types";
import { useT, type Translate } from "../i18n/LocaleProvider";
import { RefList, type AttachmentContext } from "./Attachments";
import { firstBlockLine, plainInline } from "./Markdown";
import { personSlot, type People } from "./people";
import { ParticipantIdentity, RecipientChip, Recipients, TopicChip } from "./shared/components";
import type { MessageView, Row } from "./timeline";

function typeLabel(type: Message["type"], t: Translate): string {
  switch (type) {
    case "decision-needed":
      return t("type.decision");
    case "question":
      return t("type.question");
    case "answer":
      return t("type.answer");
    case "info":
      return t("type.info");
    case "ack":
      return t("type.ack");
    case null:
      return t("chat.unknownType");
  }
}

function firstLine(message: Message, t: Translate): string {
  if (message.body.state === "locked") return t("chat.encrypted");
  const first = firstBlockLine(message.body.lines);
  return first.code ? first.text : plainInline(first.text);
}

/** What a reply needs to offer loading its original when that is older than the loaded range. */
export interface Earlier {
  /** Replies to an id sorting before this one have an older original; null when none can. */
  readonly beforeId: string | null;
  readonly disabled: boolean;
  readonly onLoad: () => void;
}

const EarlierContext = createContext<Earlier>({
  beforeId: null,
  disabled: true,
  onLoad: () => undefined,
});

/** "Reply to <id> (parent not shown)", with the id in monospace wherever the language puts it. */
function replyMissing(
  id: string,
  key: "chat.replyMissing" | "chat.replyEarlier",
  t: Translate,
): ReactNode {
  const marker = "\uE000";
  const [before = "", after = ""] = t(key, { id: marker }).split(marker);
  return (
    <>
      {before}
      <code>{id}</code>
      {after}
    </>
  );
}

function Quote({ view, people }: { view: MessageView; people: People }) {
  const t = useT();
  const earlier = useContext(EarlierContext);
  const replyTo = view.message.replyTo;
  if (replyTo === null) return null;
  if (view.parent === null) {
    if (earlier.beforeId !== null && replyTo < earlier.beforeId) {
      return (
        <p className="quote missing">
          {replyMissing(replyTo, "chat.replyEarlier", t)}{" "}
          <button type="button" disabled={earlier.disabled} onClick={earlier.onLoad}>
            {t("nav.loadOlder")}
          </button>
        </p>
      );
    }
    return <p className="quote missing">{replyMissing(replyTo, "chat.replyMissing", t)}</p>;
  }
  return (
    <a className="quote" href={`#msg-${view.parent.id}`}>
      <span className="quote-label">
        {t("chat.inReplyTo")}{" "}
        <span className="quote-from" {...personSlot(people.slot(view.parent.from))}>
          {people.label(view.parent.from)}
        </span>
        {" \u00b7 "}
        <span className="quote-type">{typeLabel(view.parent.type, t)}</span>
      </span>
      <span className="quote-text">{firstLine(view.parent, t)}</span>
    </a>
  );
}

function Receipts({ receipts, people }: { receipts: MessageReceipts; people: People }) {
  const t = useT();
  const { acknowledgements, recipients, question } = receipts;
  const status =
    question === null
      ? null
      : question.state === "unknown"
        ? t("receipt.unknown")
        : t("receipt.progress", {
            answered: question.progress?.answered ?? 0,
            target: question.progress?.target ?? 0,
          });
  return (
    <div className="receipts">
      {question !== null && (
        <p className="question-progress" data-state={question.state}>
          <span className="question-state">{t(`receipt.state.${question.state}`)}</span> {status}
        </p>
      )}
      {question !== null && question.reminders.length > 0 && (
        <p className="reminder-count">
          {t("receipt.reminders", {
            count: question.reminders.length,
            time: (question.reminders.at(-1)?.timestamp ?? "").slice(11),
          })}
        </p>
      )}
      {acknowledgements.length > 0 && (
        <ul className="acks">
          {acknowledgements.map((ack) => (
            <li key={ack.id} className="ack-receipt" title={ack.at}>
              {t("receipt.acknowledged", { name: people.label(ack.from), time: ack.at.slice(11) })}
              {ack.eta !== null && t("receipt.eta", { eta: ack.eta })}
            </li>
          ))}
        </ul>
      )}
      {question?.conclusion != null && (
        <div className="conclusion">
          <strong>
            {t("receipt.concluded", {
              name: people.label(question.conclusion.from),
              time: question.conclusion.timestamp.slice(11),
            })}
          </strong>
          <p>{question.conclusionText}</p>
        </div>
      )}
      <details className="recipients">
        <summary>{t("receipt.recipients")}</summary>
        {recipients === null ? (
          <p className="note">{t("receipt.recipientsUnknown")}</p>
        ) : (
          <ul>
            {recipients.map((recipient) => (
              <li key={recipient.name} data-state={recipient.state}>
                <RecipientChip name={recipient.name} people={people} />{" "}
                {recipient.state === "waiting"
                  ? t("receipt.recipientWaiting")
                  : t(
                      recipient.state === "answered"
                        ? "receipt.recipientAnswered"
                        : "receipt.recipientAcknowledged",
                      { time: recipient.at?.slice(11) ?? "" },
                    )}
              </li>
            ))}
          </ul>
        )}
        <p className="note">{t("receipt.note")}</p>
      </details>
    </div>
  );
}

function MessageRow({
  view,
  people,
  attachments,
}: {
  view: MessageView;
  people: People;
  attachments: AttachmentContext;
}) {
  const t = useT();
  const { message } = view;
  const compact = message.type === "ack";
  return (
    <article
      id={`msg-${message.id}`}
      className="message"
      tabIndex={-1}
      data-type={message.type ?? "unknown"}
      data-compact={compact}
      data-fresh={view.fresh}
      data-addressed={view.addressed}
    >
      <header className="meta">
        <span
          className="badge"
          data-kind={view.reminder ? "reminder" : (message.type ?? "unknown")}
        >
          {view.reminder ? t("type.reminder") : typeLabel(message.type, t)}
        </span>
        <time
          dateTime={message.timestamp.replace(" ", "T")}
          title={message.timestamp}
          aria-label={message.timestamp}
        >
          {message.timestamp.slice(11)}
          <span className="time-tooltip" aria-hidden="true">
            {message.timestamp}
          </span>
        </time>
        <span className="to-label">{t("chat.to")}</span>
        <Recipients to={message.to} people={people} />
        {message.issues.length > 0 && (
          <details className="issues">
            <summary title={t("chat.issueTitle")}>
              {t("chat.issueCount", { count: message.issues.length })}
            </summary>
            <ul>
              {message.issues.map((issue, index) => (
                <li key={`${String(index)}-${issue}`}>{issue}</li>
              ))}
            </ul>
          </details>
        )}
      </header>
      <Quote view={view} people={people} />
      {message.body.state === "locked" ? (
        <p className="body" data-body="locked">
          {t("chat.encryptedLong")}
        </p>
      ) : message.type === "ack" && message.body.lines.every((line) => line.trim() === "") ? (
        <p className="body" data-body="plain">
          <span className="ack-chip">{t("receipt.acknowledgedChip")}</span>
        </p>
      ) : (
        <p className="body" data-body="plain">
          {message.body.lines.join("\n")}
        </p>
      )}
      {message.needs !== null && (
        <p className="needs">
          <strong>{t("chat.needs")}</strong> {message.needs}
        </p>
      )}
      {message.due !== null && (
        <p className={classes("due", view.overdue && "shared-overdue")} data-overdue={view.overdue}>
          {t(view.overdue ? "chat.dueOverdue" : "chat.due", { date: message.due })}
        </p>
      )}
      {view.receipts !== null && <Receipts receipts={view.receipts} people={people} />}
      <RefList refs={message.refs} context={attachments} />
    </article>
  );
}

function RowView({
  row,
  people,
  attachments,
  showTopic,
}: {
  row: Row;
  people: People;
  attachments: AttachmentContext;
  showTopic: boolean;
}) {
  const t = useT();
  switch (row.kind) {
    case "day":
      return (
        <li className="day">
          <span>{row.date}</span>
        </li>
      );
    case "group":
      return (
        <li className="group" data-own={row.own} {...personSlot(people.slot(row.from))}>
          <div className="group-body">
            <div className="group-header">
              <ParticipantIdentity
                name={row.from}
                people={people}
                avatar
                title={row.from}
                ariaLabel={
                  people.label(row.from) === row.from
                    ? row.from
                    : `${people.label(row.from)} (${row.from})`
                }
                labelClassName="sender"
              />
              {row.own && <span className="you">{t("chat.you")}</span>}
              {showTopic && <TopicChip topic={row.topic} className="topic" />}
            </div>
            {row.messages.map((view) => (
              <MessageRow
                key={view.message.path}
                view={view}
                people={people}
                attachments={attachments}
              />
            ))}
          </div>
        </li>
      );
    case "malformed":
      return (
        <li className="card" data-kind="malformed">
          <p>
            <strong>{t("chat.unreadable")}</strong> <code>{row.path}</code>
          </p>
          <ul>
            {row.errors.map((error, index) => (
              <li key={`${String(index)}-${error}`}>{error}</li>
            ))}
          </ul>
          <details>
            <summary>{t("chat.rawText")}</summary>
            <pre>{row.raw}</pre>
          </details>
        </li>
      );
    case "unavailable":
      return (
        <li className="card" data-kind="unavailable">
          <strong>{t("chat.couldNotDownload")}</strong> <code>{row.path}</code> ({row.error})
        </li>
      );
  }
}

function rowKey(row: Row, index: number): string {
  switch (row.kind) {
    case "day":
      return `day-${row.date}-${index}`;
    case "group":
      return `group-${row.key}`;
    default:
      return `${row.kind}-${row.path}`;
  }
}

export function ChatView({
  rows,
  people,
  attachments,
  earlier,
  showTopic,
  loading = false,
}: {
  /** Topics are still being read, so no rows is not yet "no messages". */
  loading?: boolean;
  /** The topic chip is shown where messages of several topics mix; one topic needs none. */
  showTopic: boolean;
  rows: readonly Row[];
  people: People;
  attachments: AttachmentContext;
  earlier: Earlier;
}) {
  const t = useT();
  if (rows.length === 0) {
    return <p className="empty">{t(loading ? "chat.loading" : "chat.empty")}</p>;
  }
  const newMarkerIndex = rows.findIndex(
    (row) => row.kind === "group" && row.messages.some((view) => view.fresh),
  );
  return (
    <EarlierContext.Provider value={earlier}>
      <ol className="timeline">
        {rows.map((row, index) => {
          const showNewMarker = index === newMarkerIndex;
          return (
            <Fragment key={rowKey(row, index)}>
              {showNewMarker && (
                <li className="new-marker" role="separator" aria-label={t("a11y.newMessages")}>
                  <span>{t("a11y.newMessages")}</span>
                </li>
              )}
              <RowView row={row} people={people} attachments={attachments} showTopic={showTopic} />
            </Fragment>
          );
        })}
        <li id="latest-message" className="latest-anchor" aria-hidden="true" />
      </ol>
    </EarlierContext.Provider>
  );
}

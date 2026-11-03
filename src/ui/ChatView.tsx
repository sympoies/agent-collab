// Chat timeline. Message text is always rendered as React text, never as HTML.

import { Fragment } from "react";

import type { MessageReceipts } from "../message/receipts";
import type { Message } from "../message/types";
import { RefList, type AttachmentContext } from "./Attachments";
import { personStyle, type People } from "./people";
import type { MessageView, Row } from "./timeline";

function initials(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function recipients(to: readonly string[], people: People): readonly string[] {
  if (to.length === 0 || (to.length === 1 && to[0] === "all")) return ["everyone"];
  return to.map((name) => people.label(name));
}

function typeLabel(type: Message["type"]): string {
  if (type === "decision-needed") return "decision";
  return type ?? "unknown type";
}

function firstLine(message: Message): string {
  if (message.body.state === "locked") return "Encrypted message";
  return message.body.lines.find((line) => line.trim() !== "") ?? "";
}

function Quote({ view }: { view: MessageView }) {
  const replyTo = view.message.replyTo;
  if (replyTo === null) return null;
  if (view.parent === null) {
    return (
      <p className="quote missing">
        Reply to <code>{replyTo}</code> (parent not shown)
      </p>
    );
  }
  return (
    <a className="quote" href={`#msg-${view.parent.id}`}>
      <span className="quote-from">{view.parent.from}</span> {firstLine(view.parent)}
    </a>
  );
}

function Receipts({ receipts, people }: { receipts: MessageReceipts; people: People }) {
  const { acknowledgements, recipients, question } = receipts;
  const status =
    question === null
      ? null
      : question.state === "unknown"
        ? "Answers are unknown until every message of this topic is loaded."
        : `${String(question.progress?.answered ?? 0)}/${String(question.progress?.target ?? 0)} answered`;
  return (
    <div className="receipts">
      {question !== null && (
        <p className="question-progress" data-state={question.state}>
          <span className="question-state">{question.state}</span> {status}
        </p>
      )}
      {acknowledgements.length > 0 && (
        <ul className="acks">
          {acknowledgements.map((ack) => (
            <li key={ack.id} className="ack-receipt" title={ack.at}>
              {people.label(ack.from)} acknowledged {ack.at.slice(11)}
              {ack.eta !== null && ` · reply expected ${ack.eta}`}
            </li>
          ))}
        </ul>
      )}
      {question?.conclusion != null && (
        <div className="conclusion">
          <strong>
            Concluded by {people.label(question.conclusion.from)}{" "}
            {question.conclusion.timestamp.slice(11)}
          </strong>
          <p>{question.conclusionText}</p>
        </div>
      )}
      <details className="recipients">
        <summary>Recipients</summary>
        {recipients === null ? (
          <p className="note">Recipients are unknown until the participant list is loaded.</p>
        ) : (
          <ul>
            {recipients.map((recipient) => (
              <li key={recipient.name} data-state={recipient.state}>
                <span className="recipient-name">{people.label(recipient.name)}</span>{" "}
                {recipient.state === "waiting"
                  ? "no acknowledgement yet"
                  : `${recipient.state} ${recipient.at?.slice(11) ?? ""}`}
              </li>
            ))}
          </ul>
        )}
        <p className="note">
          An acknowledgement is an explicit reply. The repository does not record who merely opened
          a message, so there is no read receipt.
        </p>
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
  const { message } = view;
  const compact = message.type === "ack";
  return (
    <article
      id={`msg-${message.id}`}
      className="message"
      data-type={message.type ?? "unknown"}
      data-compact={compact}
      data-fresh={view.fresh}
      data-addressed={view.addressed}
    >
      <header className="meta">
        <time
          tabIndex={0}
          dateTime={message.timestamp.replace(" ", "T")}
          title={message.timestamp}
          aria-label={message.timestamp}
        >
          {message.timestamp.slice(11)}
          <span className="time-tooltip" aria-hidden="true">
            {message.timestamp}
          </span>
        </time>
        <span className="badge">{typeLabel(message.type)}</span>
        <span className="to-label">to</span>
        {recipients(message.to, people).map((name, index) => (
          <span key={`${String(index)}-${name}`} className="to">
            {name}
          </span>
        ))}
        {message.issues.length > 0 && (
          <details className="issues">
            <summary title="This message does not follow the protocol">
              {message.issues.length} {message.issues.length === 1 ? "issue" : "issues"}
            </summary>
            <ul>
              {message.issues.map((issue, index) => (
                <li key={`${String(index)}-${issue}`}>{issue}</li>
              ))}
            </ul>
          </details>
        )}
      </header>
      <Quote view={view} />
      {message.body.state === "locked" ? (
        <p className="body" data-body="locked">
          Encrypted message. This version cannot decrypt it yet.
        </p>
      ) : message.type === "ack" && message.body.lines.every((line) => line.trim() === "") ? (
        <p className="body" data-body="plain">
          <span className="ack-chip">acknowledged</span>
        </p>
      ) : (
        <p className="body" data-body="plain">
          {message.body.lines.join("\n")}
        </p>
      )}
      {message.needs !== null && (
        <p className="needs">
          <strong>Needs:</strong> {message.needs}
        </p>
      )}
      {message.due !== null && (
        <p className="due" data-overdue={view.overdue}>
          Due {message.due}
          {view.overdue && " (overdue)"}
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
}: {
  row: Row;
  people: People;
  attachments: AttachmentContext;
}) {
  switch (row.kind) {
    case "day":
      return (
        <li className="day">
          <span>{row.date}</span>
        </li>
      );
    case "group":
      return (
        <li className="group" data-own={row.own} style={personStyle(people.slot(row.from))}>
          <span className="avatar" aria-hidden="true">
            {initials(row.from)}
          </span>
          <div className="group-body">
            <div className="group-header">
              <span
                className="sender"
                title={row.from}
                aria-label={
                  people.label(row.from) === row.from
                    ? row.from
                    : `${people.label(row.from)} (${row.from})`
                }
              >
                {people.label(row.from)}
              </span>
              {row.own && <span className="you">You</span>}
              <span className="topic">#{row.topic}</span>
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
            <strong>Unreadable message file</strong> <code>{row.path}</code>
          </p>
          <ul>
            {row.errors.map((error, index) => (
              <li key={`${String(index)}-${error}`}>{error}</li>
            ))}
          </ul>
          <details>
            <summary>Raw text</summary>
            <pre>{row.raw}</pre>
          </details>
        </li>
      );
    case "unavailable":
      return (
        <li className="card" data-kind="unavailable">
          <strong>Could not download</strong> <code>{row.path}</code> ({row.error})
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
}: {
  rows: readonly Row[];
  people: People;
  attachments: AttachmentContext;
}) {
  if (rows.length === 0) return <p className="empty">No messages yet.</p>;
  const newMarkerIndex = rows.findIndex(
    (row) => row.kind === "group" && row.messages.some((view) => view.fresh),
  );
  return (
    <ol className="timeline">
      {rows.map((row, index) => {
        const showNewMarker = index === newMarkerIndex;
        return (
          <Fragment key={rowKey(row, index)}>
            {showNewMarker && (
              <li className="new-marker" role="separator" aria-label="New messages">
                <span>New messages</span>
              </li>
            )}
            <RowView row={row} people={people} attachments={attachments} />
          </Fragment>
        );
      })}
      <li id="latest-message" className="latest-anchor" aria-hidden="true" />
    </ol>
  );
}

// Chat timeline. Message text is always rendered as React text, never as HTML.

import type { CSSProperties } from "react";

import type { Message } from "../message/types";
import type { MessageView, Row } from "./timeline";

function senderHue(name: string): number {
  let hue = 0;
  for (const char of name) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return hue;
}

function senderStyle(name: string): CSSProperties {
  return { "--sender-hue": senderHue(name) } as CSSProperties;
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
        Reply to <code>{replyTo}</code> (not loaded; load older messages to see it)
      </p>
    );
  }
  return (
    <a className="quote" href={`#msg-${view.parent.id}`}>
      <span className="quote-from">{view.parent.from}</span> {firstLine(view.parent)}
    </a>
  );
}

function Bubble({ view }: { view: MessageView }) {
  const { message } = view;
  const compact = message.type === "ack";
  return (
    <article
      id={`msg-${message.id}`}
      className="bubble"
      data-type={message.type ?? "unknown"}
      data-compact={compact}
      data-fresh={view.fresh}
    >
      <header className="meta">
        <time>{message.timestamp.slice(11)}</time>
        <span className="badge">{message.type ?? "unknown type"}</span>
        <span className="to">to {message.to.join(", ")}</span>
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
      {message.refs.length > 0 && (
        <ul className="refs">
          {message.refs.map((ref, index) => (
            <li key={`${String(index)}-${ref}`}>{ref}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function RowView({ row }: { row: Row }) {
  switch (row.kind) {
    case "day":
      return (
        <li className="day">
          <span>{row.date}</span>
        </li>
      );
    case "group":
      return (
        <li className="group" data-align={row.align} style={senderStyle(row.from)}>
          <div className="group-header">
            <span className="sender">{row.from}</span>
            <span className="topic">#{row.topic}</span>
          </div>
          {row.messages.map((view) => (
            <Bubble key={view.message.path} view={view} />
          ))}
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

export function ChatView({ rows }: { rows: readonly Row[] }) {
  if (rows.length === 0) return <p className="empty">No messages yet.</p>;
  return (
    <ol className="timeline">
      {rows.map((row, index) => (
        <RowView key={rowKey(row, index)} row={row} />
      ))}
    </ol>
  );
}

// Questions grouped by derived state (open, concluded, answered), from deriveQuestionStates.

import { useState } from "react";

import { useT, type Translate } from "../i18n/LocaleProvider";
import { ackEta, isPlainAck, type QuestionGroups, type QuestionItem } from "../message/receipts";
import type { Message } from "../message/types";
import type { People } from "./people";
import { localDate, waitingDays } from "./relativeTime";

const SNIPPET_LINES = 3;
/** Replies shown before the rest sit behind a button, so a long thread stays short. */
const REPLY_CAP = 5;

type ReplyKind = "answer" | "reminder" | "ack";

function snippet(message: Message, t: Translate): string {
  if (message.body.state === "locked") return t("chat.encrypted");
  return message.body.lines
    .filter((line) => line.trim() !== "")
    .slice(0, SNIPPET_LINES)
    .join("\n");
}

/** The answers, reminders and acknowledgements of a question, oldest first. */
function Replies({
  item,
  people,
  onOpen,
}: {
  item: QuestionItem;
  people: People;
  onOpen: (message: Message) => void;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const { answers, reminders, acks } = item.state;
  const entries: { message: Message; kind: ReplyKind }[] = [
    ...answers.map((message) => ({ message, kind: "answer" as const })),
    ...reminders.map((message) => ({ message, kind: "reminder" as const })),
    ...acks.map((message) => ({ message, kind: "ack" as const })),
  ].sort((a, b) => (a.message.id < b.message.id ? -1 : 1));
  if (entries.length === 0) return null;
  const shown = all ? entries : entries.slice(-REPLY_CAP);
  return (
    <>
      <ul className="question-replies">
        {shown.map(({ message, kind }) => {
          if (kind === "ack" && isPlainAck(message)) {
            const eta = ackEta(message);
            return (
              <li key={message.id} className="question-ack">
                {t("receipt.acknowledged", {
                  name: people.label(message.from),
                  time: message.timestamp,
                })}
                {eta !== null && t("receipt.eta", { eta })}
              </li>
            );
          }
          return (
            <li key={message.id} className="question-reply" data-kind={kind}>
              <button
                type="button"
                className="reply-link"
                onClick={() => {
                  onOpen(message);
                }}
              >
                <span className="reply-head">
                  <span className="reply-from">{people.label(message.from)}</span>
                  <span className="badge" data-kind={kind}>
                    {t(`type.${kind}`)}
                  </span>
                  <span className="reply-time">{message.timestamp}</span>
                </span>
                <span className="reply-text">{snippet(message, t)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {entries.length > REPLY_CAP && (
        <button
          type="button"
          className="replies-toggle"
          aria-expanded={all}
          onClick={() => {
            setAll(!all);
          }}
        >
          {all ? t("questions.showFewer") : t("questions.showAll", { count: entries.length })}
        </button>
      )}
    </>
  );
}

function firstLine(message: Message, t: Translate): string {
  if (message.body.state === "locked") return t("chat.encrypted");
  return message.body.lines.find((line) => line.trim() !== "") ?? "";
}

function Item({
  item,
  people,
  now,
  onOpen,
}: {
  item: QuestionItem;
  people: People;
  now: Date;
  onOpen: (question: Message) => void;
}) {
  const t = useT();
  const { state } = item;
  const { question } = state;
  const open = state.state === "open";
  const today = localDate(now);
  const overdueDate = open && question.due !== null && question.due < today ? question.due : null;
  // Waiting counts only while nobody has answered; a partly answered question is not "unanswered".
  const days = open && state.answers.length === 0 ? waitingDays(question.timestamp, today) : 0;
  return (
    <li className="question-item" data-state={state.state}>
      <button
        type="button"
        className="question-link"
        onClick={() => {
          onOpen(question);
        }}
      >
        <span className="question-text">{firstLine(question, t)}</span>
        <span className="question-meta">
          {people.label(question.from)} · #{question.topic} · {question.timestamp}
          {state.progress !== null &&
            ` · ${t("questions.progress", { answered: state.progress.answered, target: state.progress.target })}`}
        </span>
      </button>
      {item.waitingForViewer && <span className="you">{t("questions.waiting")}</span>}
      {(overdueDate !== null || days > 0 || state.reminders.length > 0) && (
        <p className="question-badges">
          {overdueDate !== null && (
            <span className="question-overdue">
              {t("questions.overdue", { date: overdueDate })}
            </span>
          )}
          {days > 0 && (
            <span className="question-waiting">
              {t("questions.unanswered", { span: t("time.spanDays", { count: days }) })}
            </span>
          )}
          {state.reminders.length > 0 && (
            <span className="reminder-count">
              {t("receipt.reminders", {
                count: state.reminders.length,
                time: state.reminders.at(-1)?.timestamp ?? "",
              })}
            </span>
          )}
        </p>
      )}
      <Replies item={item} people={people} onOpen={onOpen} />
      {state.conclusionText !== null && <p className="conclusion-text">{state.conclusionText}</p>}
    </li>
  );
}

function Group({
  title,
  items,
  people,
  now,
  onOpen,
}: {
  title: string;
  items: readonly QuestionItem[];
  people: People;
  now: Date;
  onOpen: (question: Message) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="question-group" aria-label={title}>
      <h3>
        {title} <span className="count">{items.length}</span>
      </h3>
      <ul>
        {items.map((item) => (
          <Item
            key={item.state.question.id}
            item={item}
            people={people}
            now={now}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

export function QuestionsView({
  groups,
  people,
  now,
  onOpen,
}: {
  groups: QuestionGroups;
  people: People;
  now: Date;
  onOpen: (question: Message) => void;
}) {
  const t = useT();
  const total =
    groups.open.length + groups.concluded.length + groups.answered.length + groups.unknown.length;
  if (total === 0) return <p className="empty">{t("questions.empty")}</p>;
  return (
    <div className="questions">
      <Group
        title={t("questions.open")}
        items={groups.open}
        people={people}
        now={now}
        onOpen={onOpen}
      />
      <Group
        title={t("questions.concluded")}
        items={groups.concluded}
        people={people}
        now={now}
        onOpen={onOpen}
      />
      <Group
        title={t("questions.answered")}
        items={groups.answered}
        people={people}
        now={now}
        onOpen={onOpen}
      />
      <Group
        title={t("questions.unknown")}
        items={groups.unknown}
        people={people}
        now={now}
        onOpen={onOpen}
      />
    </div>
  );
}

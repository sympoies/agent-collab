// Questions grouped by derived state (open, concluded, answered), from deriveQuestionStates.

import { useState } from "react";

import { useT, type Translate } from "../i18n/LocaleProvider";
import { ackEta, isPlainAck, type QuestionGroups, type QuestionItem } from "../message/receipts";
import type { Message } from "../message/types";
import type { People } from "./people";
import { localDate, waitingDays } from "./relativeTime";
import type { QuestionExpansionChoices } from "./question-expansion";
import {
  EmptyState,
  MetaLine,
  ParticipantIdentity,
  RecipientChip,
  SectionHeader,
  SharedCard,
  StatusChip,
  TopicChip,
} from "./shared/components";

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
                  <ParticipantIdentity
                    name={message.from}
                    people={people}
                    labelClassName="reply-from"
                  />
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

function fullText(message: Message, t: Translate): string {
  if (message.body.state === "locked") return t("chat.encrypted");
  return message.body.lines.join("\n");
}

function Item({
  item,
  people,
  now,
  onOpen,
  expanded,
  onToggle,
}: {
  item: QuestionItem;
  people: People;
  now: Date;
  onOpen: (question: Message) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const { state } = item;
  const { question } = state;
  const open = state.state === "open";
  const today = localDate(now);
  const overdueDate = open && question.due !== null && question.due < today ? question.due : null;
  // Waiting counts only while nobody has answered; a partly answered question is not "unanswered".
  const days = open && state.answers.length === 0 ? waitingDays(question.timestamp, today) : 0;
  const tone =
    overdueDate !== null
      ? "danger"
      : state.state === "open"
        ? "attention"
        : state.state === "answered"
          ? "success"
          : "neutral";
  const status =
    overdueDate !== null
      ? t("questions.overdue", { date: overdueDate })
      : t(`receipt.state.${state.state}`);
  const bodyId = `question-body-${question.id}`;
  const targets = question.to.filter((name) => name !== "all");
  const broadcast = question.to.length === 0 || question.to.includes("all");
  return (
    <li id={`question-${question.id}`} className="question-item" data-state={state.state}>
      <SharedCard>
        <button
          type="button"
          className="question-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          onClick={onToggle}
        >
          <span className="question-text">{firstLine(question, t)}</span>
          <MetaLine>
            <ParticipantIdentity name={question.from} people={people} />
            <TopicChip topic={question.topic} />
            <time dateTime={question.timestamp.replace(" ", "T")}>{question.timestamp}</time>
            <StatusChip
              tone={tone}
              {...(overdueDate === null ? {} : { className: "question-overdue" })}
            >
              {status}
            </StatusChip>
            {state.progress !== null && (
              <span className="question-progress-count">
                {t("questions.progress", {
                  answered: state.progress.answered,
                  target: state.progress.target,
                })}
              </span>
            )}
          </MetaLine>
        </button>
        {expanded && (
          <div id={bodyId} className="question-body">
            <p className="question-full">{fullText(question, t)}</p>
            {question.needs !== null && (
              <p className="question-needs">
                <strong>{t("chat.needs")}</strong> {question.needs}
              </p>
            )}
            {question.due !== null && (
              <p className="question-due" data-overdue={overdueDate !== null}>
                {overdueDate !== null
                  ? t("chat.dueOverdue", { date: question.due })
                  : t("chat.due", { date: question.due })}
              </p>
            )}
            {(targets.length > 0 || broadcast) && (
              <MetaLine>
                <span>{t("chat.to")}</span>
                {broadcast || targets.length === 0 ? (
                  <RecipientChip name={null} people={people} />
                ) : (
                  targets.map((name) => <RecipientChip key={name} name={name} people={people} />)
                )}
              </MetaLine>
            )}
            {item.waitingForViewer && <span className="you">{t("questions.waiting")}</span>}
            {(days > 0 || state.reminders.length > 0) && (
              <p className="question-badges">
                {days > 0 && (
                  <StatusChip tone="attention" className="question-waiting">
                    {t("questions.unanswered", { span: t("time.spanDays", { count: days }) })}
                  </StatusChip>
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
            {state.conclusionText !== null && (
              <p className="conclusion-text">{state.conclusionText}</p>
            )}
            <button
              type="button"
              className="question-open-chat"
              onClick={() => {
                onOpen(question);
              }}
            >
              {t("questions.openInChat")}
            </button>
          </div>
        )}
      </SharedCard>
    </li>
  );
}

function Group({
  title,
  items,
  people,
  now,
  onOpen,
  expanded,
  onToggle,
}: {
  title: string;
  items: readonly QuestionItem[];
  people: People;
  now: Date;
  onOpen: (question: Message) => void;
  expanded: (item: QuestionItem) => boolean;
  onToggle: (item: QuestionItem) => void;
}) {
  if (items.length === 0) return null;
  const today = localDate(now);
  const sorted = [...items].sort((left, right) => {
    const leftDue = left.state.state === "open" ? left.state.question.due : null;
    const rightDue = right.state.state === "open" ? right.state.question.due : null;
    const leftOverdue = leftDue !== null && leftDue < today;
    const rightOverdue = rightDue !== null && rightDue < today;
    if (leftOverdue !== rightOverdue) return leftOverdue ? -1 : 1;
    if (left.waitingForViewer !== right.waitingForViewer) {
      return left.waitingForViewer ? -1 : 1;
    }
    return left.state.question.id.localeCompare(right.state.question.id);
  });
  return (
    <section className="question-group" aria-label={title}>
      <SectionHeader>
        <h3>
          {title} <span className="count">{items.length}</span>
        </h3>
      </SectionHeader>
      <ul>
        {sorted.map((item) => (
          <Item
            key={item.state.question.id}
            item={item}
            people={people}
            now={now}
            onOpen={onOpen}
            expanded={expanded(item)}
            onToggle={() => {
              onToggle(item);
            }}
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
  rosterKnown,
  expansionChoices,
  onExpansionChange,
}: {
  groups: QuestionGroups;
  people: People;
  now: Date;
  onOpen: (question: Message) => void;
  rosterKnown: boolean;
  expansionChoices: QuestionExpansionChoices;
  onExpansionChange: (id: string, expanded: boolean) => void;
}) {
  const t = useT();
  const total =
    groups.open.length + groups.concluded.length + groups.answered.length + groups.unknown.length;
  if (total === 0) {
    return (
      <>
        <EmptyState>{t("questions.empty")}</EmptyState>
        <div id="latest-message" className="latest-anchor" aria-hidden="true" />
      </>
    );
  }
  const defaultExpanded = (item: QuestionItem) => item.state.state !== "answered";
  const toggle = (item: QuestionItem) => {
    const id = item.state.question.id;
    onExpansionChange(id, !(expansionChoices[id] ?? defaultExpanded(item)));
  };
  const renderGroup = (title: string, items: readonly QuestionItem[]) => (
    <Group
      title={title}
      items={items}
      people={people}
      now={now}
      onOpen={onOpen}
      expanded={(item) => expansionChoices[item.state.question.id] ?? defaultExpanded(item)}
      onToggle={toggle}
    />
  );
  return (
    <div className="questions">
      {renderGroup(t("questions.open"), groups.open)}
      {renderGroup(t("questions.concluded"), groups.concluded)}
      {renderGroup(t("questions.answered"), groups.answered)}
      {groups.unknown.length > 0 && !rosterKnown && (
        <p className="question-unknown-notice">{t("questions.rosterNotice")}</p>
      )}
      {renderGroup(
        rosterKnown ? t("questions.unknown") : t("questions.unknownRoster"),
        groups.unknown,
      )}
      <div id="latest-message" className="latest-anchor" aria-hidden="true" />
    </div>
  );
}

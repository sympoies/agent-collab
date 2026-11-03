// Questions grouped by derived state (open, concluded, answered), from deriveQuestionStates.

import { useT, type Translate } from "../i18n/LocaleProvider";
import type { QuestionGroups, QuestionItem } from "../message/receipts";
import type { Message } from "../message/types";
import type { People } from "./people";

function firstLine(message: Message, t: Translate): string {
  if (message.body.state === "locked") return t("chat.encrypted");
  return message.body.lines.find((line) => line.trim() !== "") ?? "";
}

function Item({
  item,
  people,
  onOpen,
}: {
  item: QuestionItem;
  people: People;
  onOpen: (question: Message) => void;
}) {
  const t = useT();
  const { state } = item;
  const { question } = state;
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
      {state.conclusionText !== null && <p className="conclusion-text">{state.conclusionText}</p>}
    </li>
  );
}

function Group({
  title,
  items,
  people,
  onOpen,
}: {
  title: string;
  items: readonly QuestionItem[];
  people: People;
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
          <Item key={item.state.question.id} item={item} people={people} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

export function QuestionsView({
  groups,
  people,
  onOpen,
}: {
  groups: QuestionGroups;
  people: People;
  onOpen: (question: Message) => void;
}) {
  const t = useT();
  const total =
    groups.open.length + groups.concluded.length + groups.answered.length + groups.unknown.length;
  if (total === 0) return <p className="empty">{t("questions.empty")}</p>;
  return (
    <div className="questions">
      <Group title={t("questions.open")} items={groups.open} people={people} onOpen={onOpen} />
      <Group
        title={t("questions.concluded")}
        items={groups.concluded}
        people={people}
        onOpen={onOpen}
      />
      <Group
        title={t("questions.answered")}
        items={groups.answered}
        people={people}
        onOpen={onOpen}
      />
      <Group
        title={t("questions.unknown")}
        items={groups.unknown}
        people={people}
        onOpen={onOpen}
      />
    </div>
  );
}

// Questions grouped by derived state (open, concluded, answered), from deriveQuestionStates.

import type { QuestionGroups, QuestionItem } from "../message/receipts";
import type { Message } from "../message/types";
import type { People } from "./people";

function firstLine(message: Message): string {
  if (message.body.state === "locked") return "Encrypted message";
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
        <span className="question-text">{firstLine(question)}</span>
        <span className="question-meta">
          {people.label(question.from)} · #{question.topic} · {question.timestamp}
          {state.progress !== null &&
            ` · ${String(state.progress.answered)}/${String(state.progress.target)} answered`}
        </span>
      </button>
      {item.waitingForViewer && <span className="you">Waiting for you</span>}
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
  const total =
    groups.open.length + groups.concluded.length + groups.answered.length + groups.unknown.length;
  if (total === 0) return <p className="empty">No questions yet.</p>;
  return (
    <div className="questions">
      <Group title="Open" items={groups.open} people={people} onOpen={onOpen} />
      <Group title="Concluded" items={groups.concluded} people={people} onOpen={onOpen} />
      <Group title="Answered" items={groups.answered} people={people} onOpen={onOpen} />
      <Group
        title="Not yet known (loading)"
        items={groups.unknown}
        people={people}
        onOpen={onOpen}
      />
    </div>
  );
}

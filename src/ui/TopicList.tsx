import { useMemo, useState } from "react";

import { visibleTopics } from "../loader/topic-activity";
import type { TopicSummary } from "../message/topic-layout";
import { useLocale } from "../i18n/LocaleProvider";
import { TopicChip } from "./shared/components";

interface TopicListProps {
  /** Sorted: pinned topics first (not built yet), then by recent activity, closed topics last. */
  readonly topics: readonly TopicSummary[];
  /** The topic that is open; it is listed even beyond the visible limit. */
  readonly selected: string | null;
  /** The topic whose row is shown as chosen (the open topic while the chat shows it). */
  readonly pressed: string | null;
  readonly closedOpen: boolean;
  readonly onClosedOpenChange: (open: boolean) => void;
  readonly onSelect: (topic: TopicSummary, button: HTMLButtonElement) => void;
}

/**
 * The topics of a topic-layout repository inside the conversation list: the most recently active
 * open topics up to a visible limit with a button for the rest, then a collapsed Closed group.
 */
export function TopicList({
  topics,
  selected,
  pressed,
  closedOpen,
  onClosedOpenChange,
  onSelect,
}: TopicListProps) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const keep = useMemo(() => new Set(selected === null ? [] : [selected]), [selected]);
  const active = useMemo(() => topics.filter((topic) => topic.status !== "closed"), [topics]);
  const closed = useMemo(() => topics.filter((topic) => topic.status === "closed"), [topics]);
  const { shown, total, collapsible } = visibleTopics(active, { expanded, keep });
  // A closed topic that is open stays in the list while its group is collapsed.
  const pulled = closedOpen ? undefined : closed.find((topic) => topic.name === selected);

  const row = (topic: TopicSummary) => (
    <button
      key={topic.name}
      type="button"
      aria-pressed={pressed === topic.name}
      title={topic.title ?? undefined}
      onClick={(event) => {
        onSelect(topic, event.currentTarget);
      }}
    >
      <TopicChip topic={topic.name} className="topic-name" />
    </button>
  );

  return (
    <>
      {shown.map(row)}
      {collapsible && (
        <button
          type="button"
          className="show-all-topics"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {expanded ? t("topic.showFewer") : t("topic.showAll", { count: total })}
        </button>
      )}
      {pulled !== undefined && row(pulled)}
      {closed.length > 0 && (
        <details
          className="closed-topics"
          open={closedOpen}
          onToggle={(event) => {
            onClosedOpenChange(event.currentTarget.open);
          }}
        >
          <summary>{t("topic.closedCount", { count: closed.length })}</summary>
          {closed.map(row)}
        </details>
      )}
    </>
  );
}

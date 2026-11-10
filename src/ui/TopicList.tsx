import { useMemo, useState } from "react";

import { visibleTopics } from "../loader/topic-activity";
import type { TopicSummary } from "../message/topic-layout";
import { useLocale } from "../i18n/LocaleProvider";

interface TopicListProps {
  /** Sorted: pinned topics first (not built yet), then by recent activity, closed topics last. */
  readonly topics: readonly TopicSummary[];
  /** Topics whose first page has been loaded in this viewing session. */
  readonly loadedTopics: ReadonlySet<string>;
  /** Topics that remain visible even when their name and title do not match the query. */
  readonly pinnedTopics?: ReadonlySet<string>;
  readonly onLoadAll: () => void;
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
  loadedTopics,
  pinnedTopics = new Set(),
  onLoadAll,
  selected,
  pressed,
  closedOpen,
  onClosedOpenChange,
  onSelect,
}: TopicListProps) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const keep = useMemo(() => new Set(selected === null ? [] : [selected]), [selected]);
  const active = useMemo(() => topics.filter((topic) => topic.status !== "closed"), [topics]);
  const closed = useMemo(() => topics.filter((topic) => topic.status === "closed"), [topics]);
  const searchableTopics = topics.filter(
    (topic) => topic.status !== "closed" || loadedTopics.has(topic.name),
  );
  const { shown: defaultShown, total, collapsible } = visibleTopics(active, { expanded, keep });
  const normalizedQuery = query.trim().toLowerCase();
  const matches = (topic: TopicSummary) =>
    normalizedQuery === "" ||
    topic.name.toLowerCase().includes(normalizedQuery) ||
    (topic.title ?? "").toLowerCase().includes(normalizedQuery);
  const shouldKeep = (topic: TopicSummary) =>
    selected === topic.name || pinnedTopics.has(topic.name);
  const forcedClosed = topics.filter(
    (topic) => topic.status === "closed" && !loadedTopics.has(topic.name) && shouldKeep(topic),
  );
  const shown =
    normalizedQuery === ""
      ? defaultShown
      : [
          ...searchableTopics.filter(
            (topic) => (loadedTopics.has(topic.name) && matches(topic)) || shouldKeep(topic),
          ),
          ...forcedClosed,
        ];
  const activeShown = shown.filter((topic) => topic.status !== "closed");
  const closedShown = shown.filter((topic) => topic.status === "closed");
  const unloadedCount = searchableTopics.filter((topic) => !loadedTopics.has(topic.name)).length;
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
      <span className="topic-name">{t("topic.label", { topic: topic.name })}</span>
    </button>
  );

  return (
    <>
      {topics.length > 12 && (
        <div className="topic-search">
          <label>
            <span className="sr-only">{t("topic.searchLabel")}</span>
            <input
              type="search"
              aria-label={t("topic.searchLabel")}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query !== "") {
                  event.preventDefault();
                  setQuery("");
                }
              }}
            />
          </label>
          <p className="topic-search-scope">
            {t("topic.searchScope", {
              loaded: searchableTopics.length - unloadedCount,
              total: searchableTopics.length,
            })}
          </p>
          {unloadedCount > 0 && (
            <div className="topic-search-unloaded">
              <span>{t("topic.notLoaded", { count: unloadedCount })}</span>
              <button type="button" onClick={onLoadAll}>
                {t("topic.loadAll", { count: unloadedCount })}
              </button>
            </div>
          )}
        </div>
      )}
      {normalizedQuery !== "" && shown.length === 0 && <p>{t("topic.searchEmpty")}</p>}
      {activeShown.map(row)}
      {collapsible && normalizedQuery === "" && (
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
      {normalizedQuery === "" && pulled !== undefined && !closedOpen && row(pulled)}
      {normalizedQuery !== "" && closedShown.map(row)}
      {normalizedQuery === "" && closed.length > 0 && (
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

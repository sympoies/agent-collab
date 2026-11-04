import type { TopicDigest } from "./topic-session";
import type { TopicSummary } from "../message/topic-layout";

/** Open topics listed before the rest are disclosed (docs/design/topics-and-scale.md, 6.1). */
export const VISIBLE_TOPIC_LIMIT = 12;

/**
 * Open and legacy topics share the active section, most recent activity first; a topic whose
 * activity is not known yet follows them by name, and closed topics sort after the active section.
 */
export function sortTopicSummaries(
  topics: readonly TopicSummary[],
  digests: ReadonlyMap<string, TopicDigest>,
): TopicSummary[] {
  return [...topics].sort((left, right) => {
    const leftClosed = left.status === "closed";
    const rightClosed = right.status === "closed";
    if (leftClosed !== rightClosed) return leftClosed ? 1 : -1;
    const leftId = digests.get(left.name)?.newestId ?? null;
    const rightId = digests.get(right.name)?.newestId ?? null;
    if (leftId === null && rightId !== null) return 1;
    if (leftId !== null && rightId === null) return -1;
    if (leftId !== null && rightId !== null) {
      if (leftId < rightId) return 1;
      if (leftId > rightId) return -1;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

/** True when both lists name the same topics with the same titles and states, in order. */
export function sameTopics(a: readonly TopicSummary[], b: readonly TopicSummary[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (topic, index) =>
        topic.name === b[index]?.name &&
        topic.title === b[index].title &&
        topic.status === b[index].status &&
        topic.folder === b[index].folder,
    )
  );
}

export interface VisibleTopics {
  readonly shown: readonly TopicSummary[];
  /** All topics of the section, shown or not (the number the disclosure button names). */
  readonly total: number;
  /** More than the limit: the section has a disclosure button. */
  readonly collapsible: boolean;
}

/**
 * The first `VISIBLE_TOPIC_LIMIT` topics of a sorted section, or all of them once `expanded`. A
 * topic in `keep` (the selected one; later those with unread messages or open questions) shows
 * beyond the limit, in its sorted place. Pinned topics belong at the head of `topics`.
 */
export function visibleTopics(
  topics: readonly TopicSummary[],
  options: { readonly expanded: boolean; readonly keep: ReadonlySet<string> },
): VisibleTopics {
  const collapsible = topics.length > VISIBLE_TOPIC_LIMIT;
  const shown =
    options.expanded || !collapsible
      ? topics
      : topics.filter(
          (topic, index) => index < VISIBLE_TOPIC_LIMIT || options.keep.has(topic.name),
        );
  return { shown, total: topics.length, collapsible };
}

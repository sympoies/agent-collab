import type { TopicDigest } from "./topic-session";
import type { TopicSummary } from "../message/topic-layout";

/** Open and legacy topics share the active section; closed topics sort after them. */
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

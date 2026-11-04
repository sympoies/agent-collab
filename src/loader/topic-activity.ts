import type { TopicSummary } from "../message/topic-layout";
import { SourceError, type MessageSource } from "../source/types";

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export interface TopicActivity {
  readonly month: string;
  readonly fileName: string;
}

/** Reads only the newest month and newest message name, without downloading message files. */
export async function readTopicActivity(
  source: MessageSource,
  revision: string,
  topic: TopicSummary,
): Promise<TopicActivity | null> {
  if (!topic.folder) return null;
  const root = `topics/${topic.name}`;
  try {
    const entries = await source.listDirectory(revision, root);
    const inbox = entries.find((entry) => entry.kind === "directory" && entry.name === "inbox");
    if (inbox === undefined) return null;
    const months = (await source.listDirectory(revision, inbox.path))
      .filter((entry) => entry.kind === "directory" && MONTH.test(entry.name))
      .sort((left, right) => (left.name < right.name ? 1 : left.name > right.name ? -1 : 0));
    const newest = months[0];
    if (newest === undefined) return null;
    const files = (await source.listDirectory(revision, newest.path))
      .filter((entry) => entry.kind === "file" && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    const fileName = files.at(-1);
    return fileName === undefined ? null : { month: newest.name, fileName };
  } catch (error) {
    if (error instanceof SourceError && error.kind === "not-found") return null;
    throw error;
  }
}

/** Open and legacy topics share the active section; closed topics sort after them. */
export function sortTopicSummaries(
  topics: readonly TopicSummary[],
  activity: ReadonlyMap<string, TopicActivity | null>,
): TopicSummary[] {
  return [...topics].sort((left, right) => {
    const leftClosed = left.status === "closed";
    const rightClosed = right.status === "closed";
    if (leftClosed !== rightClosed) return leftClosed ? 1 : -1;
    const leftActivity = activity.get(left.name) ?? null;
    const rightActivity = activity.get(right.name) ?? null;
    if (leftActivity === null && rightActivity !== null) return 1;
    if (leftActivity !== null && rightActivity === null) return -1;
    if (leftActivity !== null && rightActivity !== null) {
      const monthOrder =
        rightActivity.month < leftActivity.month
          ? -1
          : rightActivity.month > leftActivity.month
            ? 1
            : 0;
      if (monthOrder !== 0) return monthOrder;
      const fileOrder =
        leftActivity.fileName < rightActivity.fileName
          ? 1
          : leftActivity.fileName > rightActivity.fileName
            ? -1
            : 0;
      if (fileOrder !== 0) return fileOrder;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

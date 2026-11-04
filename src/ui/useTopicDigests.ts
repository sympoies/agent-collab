import { useEffect, useState } from "react";

import type { TopicDigest, TopicSession } from "../loader/topic-session";
import type { TopicSummary } from "../message/topic-layout";
import { mapLimit } from "../source/map-limit";

/** Topic digests read at once: each is a few directory listings, never a message. */
const DIGEST_CONCURRENCY = 4;

/**
 * The recent activity of every open topic (and of the closed ones once their group is opened),
 * read in the background after the list is shown, so the list can sort and cut at its visible
 * limit. The open topic is read first, then the others by name, which is the order of the list
 * until their activity is known. A topic whose tree id did not change costs nothing again, a read
 * in progress is joined, and one that failed is read again when `retry` changes (every refresh).
 * Leaving the viewer stops the queue.
 */
export function useTopicDigests(
  session: TopicSession | null,
  topics: readonly TopicSummary[],
  selected: string | null,
  includeClosed: boolean,
  retry: number,
  onError: (error: unknown) => void,
): ReadonlyMap<string, TopicDigest> {
  const [digests, setDigests] = useState<ReadonlyMap<string, TopicDigest>>(() => new Map());
  useEffect(() => {
    if (session === null) return;
    const stopped = new AbortController();
    // A call, so the check after an await is not narrowed by the one before it.
    const isStopped = () => stopped.signal.aborted;
    const wanted = topics
      .filter((topic) => topic.folder && (includeClosed || topic.status !== "closed"))
      .map((topic) => topic.name)
      .sort((a, b) => Number(b === selected) - Number(a === selected));
    void mapLimit(wanted, DIGEST_CONCURRENCY, async (name) => {
      if (isStopped()) return;
      try {
        const digest = await session.digest(name);
        if (!isStopped()) {
          setDigests((previous) =>
            previous.get(name) === digest ? previous : new Map(previous).set(name, digest),
          );
        }
      } catch (error) {
        if (!isStopped()) onError(error);
      }
    });
    return () => {
      stopped.abort();
    };
  }, [includeClosed, onError, retry, selected, session, topics]);
  return digests;
}

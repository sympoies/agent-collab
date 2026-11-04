import { useEffect, useState } from "react";

import type { TopicDigest, TopicSession } from "../loader/topic-session";
import type { TopicSummary } from "../message/topic-layout";
import { mapLimit } from "../source/map-limit";

/** Topic digests read at once: each is a few directory listings, never a message. */
const DIGEST_CONCURRENCY = 4;

/**
 * The recent activity of every open topic (and of the closed ones once their group is opened),
 * read in the background after the list is shown, so the list can sort and cut at its visible
 * limit. A topic whose tree id did not change costs nothing again; one whose read failed is read
 * again when the topic list changes, which every successful refresh does.
 */
export function useTopicDigests(
  session: TopicSession | null,
  topics: readonly TopicSummary[],
  includeClosed: boolean,
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
      .map((topic) => topic.name);
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
  }, [includeClosed, onError, session, topics]);
  return digests;
}

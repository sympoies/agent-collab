import { useCallback, useRef, useSyncExternalStore } from "react";

import type { Loader, LoaderSnapshot } from "../loader/loader";

const EMPTY: LoaderSnapshot = {
  items: [],
  hasOlder: false,
  jumpedTo: null,
  fresh: new Set(),
  participants: [],
  formerParticipants: [],
  rosterKnown: false,
  incompleteTopics: [],
  lastChanged: null,
  lastChangedBy: null,
};

const itemPath = (item: LoaderSnapshot["items"][number]) =>
  item.kind === "message" ? item.message.path : item.path;
const itemName = (item: LoaderSnapshot["items"][number]) => {
  const path = itemPath(item);
  return path.slice(path.lastIndexOf("/") + 1);
};

/**
 * One snapshot over the topics loaded so far (the "All" view of a topic-layout repository). It
 * never pages: what a topic has not loaded is not in it, and the view says so by offering no
 * older page or jump.
 */
export function mergeSnapshots(snapshots: readonly LoaderSnapshot[]): LoaderSnapshot {
  const [first] = snapshots;
  if (first === undefined) return EMPTY;
  if (snapshots.length === 1) return first;
  const items = [
    ...new Map(snapshots.flatMap((s) => s.items).map((item) => [itemPath(item), item])).values(),
  ].sort((a, b) => (itemName(a) < itemName(b) ? -1 : itemName(a) > itemName(b) ? 1 : 0));
  const union = (pick: (s: LoaderSnapshot) => readonly string[]) =>
    [...new Set(snapshots.flatMap(pick))].sort();
  const newest = snapshots.reduce<LoaderSnapshot | null>(
    (best, s) =>
      s.lastChanged !== null && (best?.lastChanged == null || s.lastChanged > best.lastChanged)
        ? s
        : best,
    null,
  );
  return {
    items,
    hasOlder: false,
    jumpedTo: null,
    fresh: new Set(snapshots.flatMap((s) => [...s.fresh])),
    participants: union((s) => s.participants),
    formerParticipants: union((s) => s.formerParticipants),
    rosterKnown: snapshots.some((s) => s.rosterKnown),
    incompleteTopics: snapshots.some((s) => s.incompleteTopics === null)
      ? null
      : union((s) => s.incompleteTopics ?? []),
    lastChanged: newest?.lastChanged ?? null,
    lastChangedBy: newest?.lastChangedBy ?? null,
  };
}

/** Follows every loader and returns their merged snapshot, which changes only when one does. */
export function useMergedSnapshot(loaders: readonly Loader[]): LoaderSnapshot {
  const cache = useRef<{ parts: readonly LoaderSnapshot[]; merged: LoaderSnapshot } | null>(null);
  const subscribe = useCallback(
    (notify: () => void) => {
      const stops = loaders.map((loader) => loader.subscribe(notify));
      return () => {
        for (const stop of stops) stop();
      };
    },
    [loaders],
  );
  const getSnapshot = useCallback(() => {
    const parts = loaders.map((loader) => loader.getSnapshot());
    const known = cache.current;
    if (
      known !== null &&
      known.parts.length === parts.length &&
      known.parts.every((p, i) => p === parts[i])
    ) {
      return known.merged;
    }
    const merged = mergeSnapshots(parts);
    cache.current = { parts, merged };
    return merged;
  }, [loaders]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

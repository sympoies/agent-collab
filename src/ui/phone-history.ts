import { useEffect, useRef } from "react";

/** The history state of the entry that opened a topic and of every entry added above it. */
interface TopicEntry {
  readonly phoneTopic: number;
}

const entryDepth = (state: unknown): number | null =>
  typeof state === "object" &&
  state !== null &&
  "phoneTopic" in state &&
  typeof state.phoneTopic === "number"
    ? state.phoneTopic
    : null;

/**
 * Opening a topic on a phone adds one history entry so the system back gesture returns to the
 * topic list instead of leaving the viewer. Links to a message or to the latest message add
 * entries of their own (a changed fragment) above it; each is numbered by its distance from the
 * opening entry, so the in-app back control can step over all of them and never leaves one
 * behind, and a system back from inside the topic never closes it. A reload keeps the entries but
 * shows the list, so their numbering is cleared at start.
 */
export function usePhoneHistory(open: boolean, setOpen: (open: boolean) => void): void {
  const hash = useRef(window.location.hash);
  // The position of the opening entry in the history.
  const base = useRef(0);
  const depthNow = () =>
    entryDepth(window.history.state) ?? Math.max(0, window.history.length - 1 - base.current);
  useEffect(() => {
    if (entryDepth(window.history.state) !== null) window.history.replaceState(null, "");
    const onPop = () => {
      const depth = entryDepth(window.history.state);
      const fragmentOnly = window.location.hash !== hash.current;
      hash.current = window.location.hash;
      if (depth !== null) {
        setOpen(true);
      } else if (fragmentOnly) {
        // A new entry from a link: number it from its distance to the opening entry.
        const entry: TopicEntry = { phoneTopic: depthNow() };
        window.history.replaceState(entry, "");
      } else {
        setOpen(false);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
  }, [setOpen]);
  useEffect(() => {
    const marked = entryDepth(window.history.state) !== null;
    if (open && !marked) {
      const entry: TopicEntry = { phoneTopic: 0 };
      window.history.pushState(entry, "");
      base.current = window.history.length - 1;
    } else if (!open && marked) {
      // The in-app back control steps over the opening entry and every entry above it.
      window.history.go(-(depthNow() + 1));
    }
  }, [open]);
}

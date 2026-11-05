import { useEffect, useRef } from "react";

const MARK = "topic-open";

/**
 * Opening a topic on a phone adds one history entry so the system back gesture returns to the
 * topic list instead of leaving the viewer. A reload keeps the entry but shows the list, so the
 * mark is cleared at start. Links to a message or to the latest message add entries of their own
 * (a changed fragment, no mark); those never close the topic.
 */
export function usePhoneHistory(open: boolean, setOpen: (open: boolean) => void): void {
  const hash = useRef(window.location.hash);
  useEffect(() => {
    if (window.history.state === MARK) window.history.replaceState(null, "");
    const onPop = () => {
      const marked = window.history.state === MARK;
      const fragmentOnly = window.location.hash !== hash.current;
      hash.current = window.location.hash;
      if (marked) setOpen(true);
      else if (!fragmentOnly) setOpen(false);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
  }, [setOpen]);
  useEffect(() => {
    const marked = window.history.state === MARK;
    if (open && !marked) window.history.pushState(MARK, "");
    // The in-app back control pops the entry it added.
    else if (!open && marked) window.history.back();
  }, [open]);
}

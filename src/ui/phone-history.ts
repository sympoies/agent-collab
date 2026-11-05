import { useEffect } from "react";

const MARK = "topic-open";

/**
 * Opening a topic on a phone adds one history entry so the system back gesture returns to the
 * topic list instead of leaving the viewer, and the in-app back control pops that same entry.
 * Links inside the viewer add no entries (see in-page-jump.ts). A reload keeps the entry but shows
 * the list, so the mark is cleared at start.
 */
export function usePhoneHistory(open: boolean, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    if (window.history.state === MARK) window.history.replaceState(null, "");
    const onPop = () => {
      setOpen(window.history.state === MARK);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
  }, [setOpen]);
  useEffect(() => {
    const marked = window.history.state === MARK;
    if (open && !marked) window.history.pushState(MARK, "");
    else if (!open && marked) window.history.back();
  }, [open]);
}

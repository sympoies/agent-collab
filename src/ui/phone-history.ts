import { useEffect } from "react";

const MARK = "topic-open";

/**
 * Opening a topic on a phone adds one history entry so the system back gesture returns to the
 * topic list instead of leaving the viewer, and the in-app back control pops that same entry.
 * Links inside the viewer add no entries (see in-page-jump.ts). A reload keeps the entry: when the
 * topic screen starts open (#80) the entry is kept, not added again; under the list it is cleared.
 */
export function usePhoneHistory(open: boolean, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    // A mark kept across a reload belongs to the screen that starts open; only a mark under the
    // list is stale.
    if (!open && window.history.state === MARK) window.history.replaceState(null, "");
    const onPop = () => {
      setOpen(window.history.state === MARK);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
    // Only the state at mount decides: later changes go through the second effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setOpen]);
  useEffect(() => {
    const marked = window.history.state === MARK;
    if (open && !marked) window.history.pushState(MARK, "");
    else if (!open && marked) window.history.back();
  }, [open]);
}

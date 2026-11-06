// Scroll behaviour of the message pane: open at the newest message, follow new ones while the
// reader is at the bottom, keep the visible message in place when older ones are prepended, and
// land at the start of a day after "Jump to date".

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import type { Row } from "./timeline";

/** How close to the bottom still counts as "at the bottom", in CSS pixels. */
const BOTTOM_THRESHOLD = 80;

/** A finished "Jump to date": the requested day, or null for "back to the newest page". */
export interface DateLanding {
  readonly date: string | null;
}

function messageIds(rows: readonly Row[]): { first: string | null; last: string | null } {
  let first: string | null = null;
  let last: string | null = null;
  for (const row of rows) {
    if (row.kind !== "group") continue;
    for (const view of row.messages) {
      first ??= view.message.id;
      last = view.message.id;
    }
  }
  return { first, last };
}

const atBottom = (pane: HTMLElement) =>
  pane.clientHeight + pane.scrollTop >= pane.scrollHeight - BOTTOM_THRESHOLD;

// An instant jump: the pane's smooth scrolling is for in-page links, not for landing.
const scrollTo = (pane: HTMLElement, top: number) => {
  pane.scrollTo({ top, behavior: "instant" });
};

/** The first message or reference card that is at least partly in view and its pane offset. */
function visibleAnchor(pane: HTMLElement): { readonly id: string; readonly offset: number } | null {
  const entries = pane.querySelectorAll<HTMLElement>(".message, .question-item, .file-item");
  const top = pane.getBoundingClientRect().top;
  // Entries are in document order, so the first one whose bottom is below the top edge is found
  // by bisection.
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((entries[middle] as HTMLElement).getBoundingClientRect().bottom > top) high = middle;
    else low = middle + 1;
  }
  const entry = entries[low];
  return entry === undefined || entry.id === ""
    ? null
    : { id: entry.id, offset: entry.getBoundingClientRect().top - top };
}

/** The first message of `day` in the pane, else null. Ids start with their timestamp. */
function firstOfDay(pane: HTMLElement, day: string): HTMLElement | null {
  return pane.querySelector<HTMLElement>(`[id^="msg-${day}T"]`);
}

/**
 * `viewKey` names what the pane shows (null when it is not the chat); a new key lands at the
 * latest message. A pending jump keeps the landing for a message the reader asked for by link.
 * `shown` changes when the pane becomes visible or hidden (the phone shows one screen at a time).
 * A new `dateLanding` lands at the start of that day and stops following until the reader is at
 * the bottom again.
 */
export function useFollowLatest(
  pane: HTMLElement | null,
  viewKey: string | null,
  shown: boolean,
  rows: readonly Row[],
  pendingJump: RefObject<string | null>,
  dateLanding: DateLanding | null,
): void {
  const state = useRef({
    key: null as string | null,
    landed: false,
    firstLanding: true,
    first: null as string | null,
    last: null as string | null,
    anchor: null as { readonly id: string; readonly offset: number } | null,
    following: true,
    // After a jump to a date the pane stays where it is until the reader leaves and returns.
    held: false,
    dateLanding: null as DateLanding | null,
    observer: null as ResizeObserver | null,
    observed: null as Element | null,
    element: null as HTMLElement | null,
    detach: null as (() => void) | null,
  });

  // The pane may render after this hook first runs (the viewer shows it once its topics are
  // known), so the listeners follow the element: attached when it appears, dropped when it goes.
  const attach = (element: HTMLElement | null) => {
    const current = state.current;
    if (element === current.element) return;
    current.detach?.();
    current.element = element;
    current.detach = null;
    current.observed = null;
    if (element === null) return;
    const track = () => {
      const bottom = atBottom(element);
      if (!bottom) current.held = false;
      current.following = bottom && !current.held;
      current.anchor = visibleAnchor(element);
    };
    element.addEventListener("scroll", track, { passive: true });
    // Content that grows after landing (a preview that finishes loading, a wrapped line) keeps
    // the bottom in view while following, and otherwise only refreshes the remembered anchor.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (current.following && current.landed && element.clientHeight > 0) {
              scrollTo(element, element.scrollHeight);
            }
            current.anchor = visibleAnchor(element);
          });
    current.observer = observer;
    current.detach = () => {
      element.removeEventListener("scroll", track);
      observer?.disconnect();
      current.observer = null;
    };
  };
  useEffect(
    () => () => {
      state.current.detach?.();
      state.current.element = null;
    },
    [],
  );

  useLayoutEffect(() => {
    const current = state.current;
    const element = pane;
    attach(element);
    if (viewKey !== current.key) {
      current.key = viewKey;
      current.landed = false;
    }
    if (viewKey === null || element === null) return;
    // A hidden pane has no layout to scroll; it lands when it is shown.
    if (element.clientHeight === 0) {
      current.landed = false;
      return;
    }
    // A view root is replaced when the pane switches page; watch its size so expanding cards can
    // keep the bottom in view when the reader was following the newest entries.
    const content = element.querySelector(".timeline, .questions, .files-view, .files");
    if (content !== current.observed) {
      current.observer?.disconnect();
      if (content !== null) current.observer?.observe(content);
      current.observed = content;
    }
    // Questions and Files are lists to scan: they open at the top and never follow the bottom.
    if (!viewKey.startsWith("chat:")) {
      if (!current.landed) {
        current.landed = true;
        current.following = false;
        current.held = false;
        scrollTo(element, 0);
      }
      return;
    }
    const { first, last } = messageIds(rows);
    if (last === null) return;
    if (!current.landed) {
      current.landed = true;
      const linked =
        current.firstLanding && document.getElementById(window.location.hash.slice(1)) !== null;
      current.firstLanding = false;
      if (pendingJump.current === null && !linked) {
        scrollTo(element, element.scrollHeight);
        // Landing at the bottom resumes following, also when nothing moved (a short chat, so no
        // scroll event) after a list page that stopped it.
        current.following = true;
        current.held = false;
      }
    } else if (first !== current.first || last !== current.last) {
      if (last !== current.last && current.following) {
        scrollTo(element, element.scrollHeight);
      } else if (!current.following) {
        // Data arriving above the visible entry keeps that entry at the same screen offset.
        const kept = current.anchor === null ? null : document.getElementById(current.anchor.id);
        if (current.anchor !== null && kept !== null) {
          const moved =
            kept.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            current.anchor.offset;
          scrollTo(element, element.scrollTop + moved);
        }
      }
    }
    current.first = first;
    current.last = last;
    current.anchor = visibleAnchor(element);
  }, [pane, viewKey, shown, rows, pendingJump]);

  // After "Jump to date" the page ends on the requested day: land at that day's first message,
  // never at the bottom. This is a passive effect on purpose: it runs after the date field takes
  // focus back (a child effect), whose own scrolling would otherwise win.
  useEffect(() => {
    const current = state.current;
    const element = pane;
    if (dateLanding === current.dateLanding) return;
    current.dateLanding = dateLanding;
    if (dateLanding === null || element === null || !current.landed || current.last === null) {
      return;
    }
    const day = dateLanding.date;
    const target =
      day === null
        ? null
        : (firstOfDay(element, day) ?? firstOfDay(element, current.last.slice(0, 10)));
    if (target === null) {
      scrollTo(element, element.scrollHeight);
      current.held = false;
      current.following = true;
    } else {
      const top =
        target.getBoundingClientRect().top -
        element.getBoundingClientRect().top +
        element.scrollTop;
      scrollTo(element, top);
      current.held = true;
      current.following = false;
    }
    current.anchor = visibleAnchor(element);
  }, [pane, dateLanding]);
}

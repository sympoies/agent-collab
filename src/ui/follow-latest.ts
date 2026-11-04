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

/** The first message that is at least partly in view and where it sits in the pane. */
function visibleAnchor(pane: HTMLElement): { readonly id: string; readonly offset: number } | null {
  const messages = pane.querySelectorAll<HTMLElement>(".message");
  const top = pane.getBoundingClientRect().top;
  // Messages are in document order, so the first one whose bottom is below the top edge is found
  // by bisection.
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((messages[middle] as HTMLElement).getBoundingClientRect().bottom > top) high = middle;
    else low = middle + 1;
  }
  const message = messages[low];
  return message === undefined
    ? null
    : { id: message.id, offset: message.getBoundingClientRect().top - top };
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
  pane: RefObject<HTMLElement | null>,
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
  });

  useEffect(() => {
    const element = pane.current;
    if (element === null) return;
    const current = state.current;
    const track = () => {
      const bottom = atBottom(element);
      if (!bottom) current.held = false;
      current.following = bottom && !current.held;
      current.anchor = visibleAnchor(element);
    };
    element.addEventListener("scroll", track, { passive: true });
    // Content that grows after landing (a preview that finishes loading, a wrapped line) keeps
    // the bottom in view while following, and otherwise only refreshes the remembered height.
    current.observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (current.following && current.landed && element.clientHeight > 0) {
              scrollTo(element, element.scrollHeight);
            }
            current.anchor = visibleAnchor(element);
          });
    return () => {
      element.removeEventListener("scroll", track);
      current.observer?.disconnect();
      current.observer = null;
      current.observed = null;
    };
  }, [pane]);

  useLayoutEffect(() => {
    const current = state.current;
    const element = pane.current;
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
    // The timeline is replaced when the pane switches view; watch the current one.
    const timeline = element.querySelector(".timeline");
    if (timeline !== current.observed) {
      current.observer?.disconnect();
      if (timeline !== null) current.observer?.observe(timeline);
      current.observed = timeline;
    }
    const { first, last } = messageIds(rows);
    if (last === null) return;
    if (!current.landed) {
      current.landed = true;
      const linked =
        current.firstLanding && document.getElementById(window.location.hash.slice(1)) !== null;
      current.firstLanding = false;
      if (pendingJump.current === null && !linked) scrollTo(element, element.scrollHeight);
    } else if (first !== current.first && last === current.last) {
      // Older messages were added above: keep the message that was in view where it was.
      const kept = current.anchor === null ? null : document.getElementById(current.anchor.id);
      if (current.anchor !== null && kept !== null) {
        const moved =
          kept.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          current.anchor.offset;
        scrollTo(element, element.scrollTop + moved);
      }
    } else if (last !== current.last && current.following) {
      scrollTo(element, element.scrollHeight);
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
    const element = pane.current;
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

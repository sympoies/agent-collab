// Scroll behaviour of the message pane: open at the newest message, follow new ones while the
// reader is at the bottom, and keep the visible message in place when older ones are prepended.

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import type { Row } from "./timeline";

/** How close to the bottom still counts as "at the bottom", in CSS pixels. */
const BOTTOM_THRESHOLD = 80;

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

/**
 * `viewKey` names what the pane shows (null when it is not the chat); a new key lands at the
 * latest message. A pending jump keeps the landing for a message the reader asked for by link.
 * `shown` changes when the pane becomes visible or hidden (the phone shows one screen at a time).
 */
export function useFollowLatest(
  pane: RefObject<HTMLElement | null>,
  viewKey: string | null,
  shown: boolean,
  rows: readonly Row[],
  pendingJump: RefObject<string | null>,
): void {
  const state = useRef({
    key: null as string | null,
    landed: false,
    firstLanding: true,
    first: null as string | null,
    last: null as string | null,
    height: 0,
    following: true,
  });

  useEffect(() => {
    const element = pane.current;
    if (element === null) return;
    const track = () => {
      state.current.following = atBottom(element);
      state.current.height = element.scrollHeight;
    };
    element.addEventListener("scroll", track, { passive: true });
    return () => {
      element.removeEventListener("scroll", track);
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
    const { first, last } = messageIds(rows);
    if (last === null) return;
    if (!current.landed) {
      current.landed = true;
      const linked =
        current.firstLanding && document.getElementById(window.location.hash.slice(1)) !== null;
      current.firstLanding = false;
      if (pendingJump.current === null && !linked) scrollTo(element, element.scrollHeight);
    } else if (first !== current.first && last === current.last) {
      // Older messages were added above: move by their height so the reader stays put.
      scrollTo(element, element.scrollTop + element.scrollHeight - current.height);
    } else if (last !== current.last && current.following) {
      scrollTo(element, element.scrollHeight);
    }
    current.first = first;
    current.last = last;
    current.height = element.scrollHeight;
  }, [pane, viewKey, shown, rows, pendingJump]);
}

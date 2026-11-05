/**
 * Every element that pops up over the page from a control. This is the single list a new popup
 * must join: `tests/popups.test.ts` fails when the stylesheet gives a rule a popover shadow that
 * is not listed here, and `e2e/popups.spec.ts` opens each entry at phone widths and checks it
 * stays inside the viewport. A popup is positioned by the stylesheet alone (no inline styles).
 */
export interface PopupEntry {
  /** The stylesheet selector of the popup element. */
  readonly selector: string;
  /** The space the popup keeps to every edge of the viewport, in px; a full-screen sheet keeps none. */
  readonly margin: number;
}

export const POPUPS: readonly PopupEntry[] = [
  { selector: ".menu", margin: 8 },
  { selector: "#profile-panel", margin: 0 },
  { selector: ".topic-menu-body", margin: 8 },
  { selector: ".time-tooltip", margin: 8 },
];

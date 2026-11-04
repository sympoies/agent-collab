// Plain relative text for "how long ago", without warning thresholds.

import type { Translate } from "../i18n/LocaleProvider";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(then: Date, now: Date, t: Translate): string {
  const elapsed = now.getTime() - then.getTime();
  // A time in the future (clock skew) and anything under 45 seconds is "just now".
  if (elapsed < 45 * SECOND) return t("time.justNow");
  if (elapsed < HOUR) {
    return t("time.minutes", { count: Math.min(59, Math.max(1, Math.round(elapsed / MINUTE))) });
  }
  if (elapsed < DAY) return t("time.hours", { count: Math.floor(elapsed / HOUR) });
  return t("time.days", { count: Math.floor(elapsed / DAY) });
}

/** Today as YYYY-MM-DD in the viewer's time zone. */
export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Whole days a message has waited, from the date in its id to today (YYYY-MM-DD). The id time
 * zone is not recorded, so only the dates are compared, as for a due date; the value is approximate.
 */
export function waitingDays(timestamp: string, today: string): number {
  const day = 24 * HOUR;
  const elapsed =
    Date.parse(`${today}T00:00:00Z`) - Date.parse(`${timestamp.slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.floor(elapsed / day));
}

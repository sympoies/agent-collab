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

/** A span such as "3 days", for text that says how long something has lasted. */
export function spanText(from: Date, now: Date, t: Translate): string {
  const elapsed = Math.max(0, now.getTime() - from.getTime());
  if (elapsed < HOUR)
    return t("time.spanMinutes", { count: Math.max(1, Math.floor(elapsed / MINUTE)) });
  if (elapsed < DAY) return t("time.spanHours", { count: Math.floor(elapsed / HOUR) });
  return t("time.spanDays", { count: Math.floor(elapsed / DAY) });
}

/** A message timestamp ("YYYY-MM-DD HH:MM") as a local Date; the repository's zone is not recorded. */
export function timestampDate(timestamp: string): Date {
  const [date = "", time = ""] = timestamp.split(" ");
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

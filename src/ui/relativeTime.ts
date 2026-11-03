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

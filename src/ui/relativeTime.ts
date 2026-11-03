// Plain relative text for "how long ago", without warning thresholds.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? "" : "s"} ago`;
}

export function relativeTime(then: Date, now: Date): string {
  const elapsed = now.getTime() - then.getTime();
  // A time in the future (clock skew) and anything under 45 seconds is "just now".
  if (elapsed < 45 * SECOND) return "just now";
  if (elapsed < HOUR) {
    return plural(Math.min(59, Math.max(1, Math.round(elapsed / MINUTE))), "minute");
  }
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), "hour");
  return plural(Math.floor(elapsed / DAY), "day");
}

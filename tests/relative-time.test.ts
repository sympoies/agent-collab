import { describe, expect, it } from "vitest";

import { relativeTime } from "../src/ui/relativeTime";
import { tEn } from "./support";

const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it.each([
    [0, "just now"],
    [44 * SECOND, "just now"],
    [45 * SECOND, "1 minute ago"],
    [89 * SECOND, "1 minute ago"],
    [2 * MINUTE, "2 minutes ago"],
    [59 * MINUTE, "59 minutes ago"],
    [60 * MINUTE, "1 hour ago"],
    [5 * HOUR + 30 * MINUTE, "5 hours ago"],
    [23 * HOUR + 59 * MINUTE, "23 hours ago"],
    [24 * HOUR, "1 day ago"],
    [10 * DAY, "10 days ago"],
    [400 * DAY, "400 days ago"],
  ])("shows %i ms as %s", (elapsed, text) => {
    expect(relativeTime(ago(elapsed), NOW, tEn)).toBe(text);
  });

  it("treats a time slightly in the future (clock skew) as just now", () => {
    expect(relativeTime(new Date(NOW.getTime() + 30 * SECOND), NOW, tEn)).toBe("just now");
  });
});

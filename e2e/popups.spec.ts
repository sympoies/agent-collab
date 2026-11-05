// Every popup stays inside a phone viewport, however far along the bar its trigger sits, and no
// item text is clipped. The popups come from one list (src/ui/popups.ts) that this test walks:
// a popup without an opener here fails the test, and tests/popups.test.ts fails a stylesheet rule
// that is not in the list. Synthetic data only. The "@csp" tag also runs these in WebKit.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { POPUPS } from "../src/ui/popups";
import { en } from "../src/i18n/catalog";
import { messageText } from "../tests/support";

const IDS = ["2026-11-04T0901-alice-agent-api-01", "2026-11-04T0902-bob-agent-api-01"];
const snapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:59:00.000Z",
  revision: "r1",
  files: [
    { path: ".agent-collab", text: "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n" },
    ...IDS.map((id, n) => ({
      path: `inbox/2026-11/${id}.md`,
      text: messageText(
        id,
        n === 0 ? "alice-agent" : "bob-agent",
        "api",
        {},
        `Message ${String(n + 1)}.`,
      ),
    })),
  ],
});

/** How each popup is opened; the keys are the selectors in POPUPS. */
const OPENERS: Record<string, (page: Page) => Promise<void>> = {
  ".menu": async (page) => {
    await page.getByRole("button", { name: en["bar.more"], exact: true }).click();
  },
  "#profile-panel": async (page) => {
    await page.locator(".bar-actions .identity-button").click();
  },
  ".topic-menu-body": async (page) => {
    await page.locator(".topic-menu summary").click();
  },
  ".time-tooltip": async (page) => {
    await page.locator(".meta time").last().hover();
  },
};

// Only the More menu's trigger can sit at different places along the bar (the bar is given the
// full width and its buttons are packed to the start, middle or end). The topic options button
// ends the sticky bar, the tooltip is anchored to a message time and the profile panel is a
// full-screen sheet, so those are checked once, as laid out.
const MOVABLE = new Set([".menu"]);
const POSITIONS = ["flex-start", "center", "flex-end"] as const;
/** Where the middle of the More button must be, as a share of the viewport width, per position. */
const EXPECTED_CENTER: Record<(typeof POSITIONS)[number], readonly [number, number]> = {
  "flex-start": [0, 0.4],
  center: [0.4, 0.8],
  "flex-end": [0.8, 1],
};
const shots = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";

// The portrait phones of the acceptance criteria (360, 390 and 430), and a landscape one (still
// under the 720 px phone layout).
const SIZES = [
  { width: 360, height: 740 },
  { width: 390, height: 740 },
  { width: 430, height: 932 },
  { width: 640, height: 360 },
];

for (const { width, height } of SIZES) {
  test.describe(`popups at ${String(width)}x${String(height)} @csp`, () => {
    test("every popup has an opener in this test @csp", () => {
      expect(Object.keys(OPENERS).sort()).toEqual(POPUPS.map((popup) => popup.selector).sort());
    });

    for (const popup of POPUPS) {
      for (const position of MOVABLE.has(popup.selector) ? POSITIONS : (["as laid out"] as const)) {
        test(`${popup.selector} stays inside the viewport, trigger ${position} @csp`, async ({
          page,
        }) => {
          await page.route("**/hosted-snapshot.json", (route) =>
            route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
          );
          await page.setViewportSize({ width, height });
          await page.goto("/");
          await page.getByRole("button", { name: en["nav.all"], exact: true }).click();
          await expect(page.locator(".message").first()).toBeVisible();
          if (position !== "as laid out") {
            // Give the bar the full width and pack its buttons to the start, middle or end, then
            // check the More button really moved there before opening the menu.
            await page.locator(".bar-actions").evaluate((node, value) => {
              node.style.width = "100%";
              node.style.justifyContent = value;
            }, position);
            const trigger = await page
              .getByRole("button", { name: en["bar.more"], exact: true })
              .boundingBox();
            expect(trigger).not.toBeNull();
            const center = ((trigger?.x ?? 0) + (trigger?.width ?? 0) / 2) / width;
            const [low, high] = EXPECTED_CENTER[position];
            expect(center, "the trigger's place along the bar").toBeGreaterThanOrEqual(low);
            expect(center, "the trigger's place along the bar").toBeLessThanOrEqual(high);
          }
          const opener = OPENERS[popup.selector];
          expect(opener, popup.selector).toBeDefined();
          await opener?.(page);
          const element = page.locator(popup.selector).filter({ visible: true }).first();
          await expect(element).toBeVisible();
          const box = await element.boundingBox();
          const viewport = page.viewportSize();
          expect(box).not.toBeNull();
          if (box === null || viewport === null) return;
          const m = popup.margin;
          expect(box.x, "left edge").toBeGreaterThanOrEqual(m - 0.5);
          expect(box.y, "top edge").toBeGreaterThanOrEqual(m - 0.5);
          expect(box.x + box.width, "right edge").toBeLessThanOrEqual(viewport.width - m + 0.5);
          expect(box.y + box.height, "bottom edge").toBeLessThanOrEqual(viewport.height - m + 0.5);
          // No text is cut: every descendant fits the popup, and no item overflows its own box.
          const clipped = await element.evaluate((root): string[] =>
            [root as HTMLElement, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]
              .filter((node) => node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0)
              .filter((node) => getComputedStyle(node).overflowX !== "auto")
              .map((node): string => node.getAttribute("class") ?? node.tagName),
          );
          expect(clipped, "clipped text").toEqual([]);
          if (shots !== "" && (position === "flex-start" || position === "as laid out")) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(
                shots,
                `popup-${popup.selector.replace(/[^a-z]+/g, "")}-${String(width)}x${String(height)}.png`,
              ),
            });
          }
        });
      }
    }
  });
}

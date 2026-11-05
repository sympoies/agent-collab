// Box tests for the viewer frame (issue #85): the header keeps the panel inset, the chat frame's
// border is not covered by the scrollbar, and "Jump to latest" stays clear of the border and the
// scrollbar. Synthetic data only. The "@csp" tag also runs these in WebKit.
// Screenshots: LAYOUT_SHOTS=<prefix> PLAYWRIGHT_SCREENSHOT_DIR=<dir> writes
// <prefix>-<width>-<theme>.png for the three widths and both themes.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { messageText } from "../tests/support";

const COUNT = 40;
const id = (n: number) => `2026-11-04T09${String(n).padStart(2, "0")}-alice-agent-general-01`;
const snapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:59:00.000Z",
  revision: "r1",
  files: [
    {
      path: ".agent-collab",
      text: "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent\n",
    },
    ...Array.from({ length: COUNT }, (_, n) => ({
      path: `topics/general/inbox/2026-11/${id(n + 1)}.md`,
      text: messageText(
        id(n + 1),
        "alice-agent",
        "general",
        {},
        `Message number ${String(n + 1)}.\n\nA second line so each message is tall enough to scroll.`,
      ),
    })),
  ],
});

async function open(page: Page, width: number, theme = "paper") {
  await page.addInitScript((value) => {
    localStorage.setItem("agent-collab-viewer.theme", value);
  }, theme);
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "#general", exact: true }).click();
  await expect(page.getByText(`Message number ${String(COUNT)}.`)).toBeVisible();
}

for (const width of [1280, 390] as const) {
  test.describe(`the viewer frame at ${String(width)} px @csp`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, width);
    });

    test("the header content keeps the inset of the panels below @csp", async ({ page }) => {
      const m = await page.evaluate(() => {
        const bar = document.querySelector(".bar") as HTMLElement;
        const panel = document.querySelector(".topics-pane, .conversation") as HTMLElement;
        // The title is hidden on a phone, so measure what is shown.
        const shown = [...bar.children]
          .map((node) => node.getBoundingClientRect())
          .filter((box) => box.width > 0);
        const box = bar.getBoundingClientRect();
        return {
          inset: parseFloat(getComputedStyle(panel).paddingLeft),
          left: Math.min(...shown.map((r) => r.left)) - box.left,
          right: box.right - Math.max(...shown.map((r) => r.right)),
        };
      });
      expect(m.left).toBeGreaterThanOrEqual(m.inset);
      expect(m.right).toBeGreaterThanOrEqual(m.inset);
    });

    test("the scrollbar sits inside the border of the chat frame @csp", async ({ page }) => {
      const m = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".conversation");
        if (scroller === null) throw new Error("no message pane");
        const frame = document.querySelector<HTMLElement>(".conversation-frame");
        const box = (frame ?? scroller).getBoundingClientRect();
        const style = getComputedStyle(frame ?? scroller);
        return {
          framed: frame !== null,
          scrollerRight: scroller.getBoundingClientRect().right,
          frameRight: box.right,
          border: parseFloat(style.borderRightWidth),
          scrolls: scroller.scrollHeight > scroller.clientHeight,
        };
      });
      expect(m.framed).toBe(true);
      expect(m.scrolls).toBe(true);
      expect(m.border).toBeGreaterThan(0);
      expect(m.frameRight - m.scrollerRight).toBeGreaterThanOrEqual(m.border);
    });

    test("Jump to latest stays clear of the border and the scrollbar @csp", async ({ page }) => {
      const jump = page.locator(".jump-to-latest");
      await expect(jump).toBeVisible();
      const m = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".conversation");
        if (scroller === null) throw new Error("no message pane");
        const frame = document.querySelector<HTMLElement>(".conversation-frame") ?? scroller;
        const button = (
          document.querySelector(".jump-to-latest") as HTMLElement
        ).getBoundingClientRect();
        const frameBox = frame.getBoundingClientRect();
        const scrollerBox = scroller.getBoundingClientRect();
        const scrollbar = scroller.offsetWidth - scroller.clientWidth;
        return {
          right: frameBox.right - button.right,
          bottom: frameBox.bottom - button.bottom,
          left: button.left - frameBox.left,
          top: button.top - frameBox.top,
          clearOfScrollbar: scrollerBox.right - scrollbar - button.right,
        };
      });
      expect(m.right).toBeGreaterThanOrEqual(8);
      expect(m.bottom).toBeGreaterThanOrEqual(8);
      expect(m.left).toBeGreaterThanOrEqual(8);
      expect(m.top).toBeGreaterThanOrEqual(8);
      expect(m.clearOfScrollbar).toBeGreaterThanOrEqual(8);
    });
  });
}

test.describe("Jump to latest is only in the chat @csp", () => {
  test("it is gone on Files @csp", async ({ page }) => {
    await open(page, 1280);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(page.locator(".jump-to-latest")).toHaveCount(0);
  });
});

const prefix = process.env.LAYOUT_SHOTS;
test.describe("screenshots", () => {
  test.skip(prefix === undefined, "set LAYOUT_SHOTS to write screenshots");
  for (const width of [390, 768, 1280]) {
    for (const theme of ["paper", "night-owl"]) {
      test(`${String(width)} ${theme}`, async ({ page }) => {
        await open(page, width, theme);
        const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
        mkdirSync(directory, { recursive: true });
        await page.screenshot({
          path: join(directory, `${prefix ?? "shot"}-${String(width)}-${theme}.png`),
        });
      });
    }
  }
});

// The overdue due line is one shared tinted highlight in the chat message and on the Questions
// card (issue #97): no underline, a visible tint, and the "! " prefix; a due date that is not
// overdue stays plain. Synthetic data only. The "@csp" tag also runs these in WebKit.
// Screenshots: OVERDUE_SHOTS=<prefix> PLAYWRIGHT_SCREENSHOT_DIR=<dir> writes
// <prefix>-<place>-<width>-<theme>.png.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { flat, MARKER, messageText } from "../tests/support";

const LATE = "2026-10-01T0901-alice-agent-api-01";
const FUTURE = "2026-10-01T0902-alice-agent-api-01";
const snapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:00:00.000Z",
  revision: "r1",
  files: [
    { path: ".agent-collab", text: `${MARKER}participants: alice-agent, bob-agent\n` },
    {
      path: flat("2026-10", 1, 1),
      text: messageText(
        LATE,
        "alice-agent",
        "api",
        { type: "question", needs: "answer", to: "bob-agent", due: "2020-01-01" },
        "Which option do we ship?",
      ),
    },
    {
      path: flat("2026-10", 1, 2),
      text: messageText(
        FUTURE,
        "alice-agent",
        "api",
        { type: "question", needs: "answer", to: "bob-agent", due: "2099-12-31" },
        "And what comes after that?",
      ),
    },
  ],
});

async function open(page: Page, width: number, theme: string) {
  await page.addInitScript((value) => {
    localStorage.setItem("agent-collab-viewer.theme", value);
  }, theme);
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  // On a phone the topic list comes first.
  await page.getByRole("button", { name: /^#api/ }).click();
  await expect(page.getByText("Which option do we ship?")).toBeVisible();
}

const style = (locator: Locator) =>
  locator.evaluate((node) => {
    const own = getComputedStyle(node);
    return {
      underline: own.textDecorationLine,
      background: own.backgroundColor,
      prefix: getComputedStyle(node, "::before").content,
    };
  });

const THEMES = ["paper", "night-owl"] as const;
for (const width of [390, 1280] as const) {
  for (const theme of THEMES) {
    test.describe(`${theme} at ${String(width)} px @csp`, () => {
      test("an overdue due line in the chat is a tinted highlight with a prefix @csp", async ({
        page,
      }) => {
        await open(page, width, theme);
        const late = page.locator("[data-overdue='true']").first();
        const plain = page.locator("[data-overdue='false']").first();
        await expect(late).toBeVisible();
        const overdue = await style(late);
        expect(overdue.underline).toBe("none");
        expect(overdue.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(overdue.prefix).toContain("!");
        const normal = await style(plain);
        expect(normal.background).toBe("rgba(0, 0, 0, 0)");
        expect(normal.prefix === "none" || normal.prefix === "normal").toBe(true);
      });

      test("the same highlight is on the Questions card @csp", async ({ page }) => {
        await open(page, width, theme);
        if (width === 390)
          await page.getByRole("button", { name: "Back to conversations" }).click();
        await page.getByRole("button", { name: /^Questions/ }).click();
        const card = page.locator(".question-item").first();
        await expect(card).toBeVisible();
        const chip = card.locator(".shared-overdue").first();
        const chipStyle = await style(chip);
        expect(chipStyle.underline).toBe("none");
        expect(chipStyle.background).not.toBe("rgba(0, 0, 0, 0)");
        const toggle = card.locator(".question-toggle");
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        const due = card.locator(".question-due[data-overdue='true']");
        await expect(due).toBeVisible();
        const dueStyle = await style(due);
        expect(dueStyle.underline).toBe("none");
        expect(dueStyle.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(dueStyle.prefix).toContain("!");
      });
    });
  }
}

const prefix = process.env.OVERDUE_SHOTS;
test.describe("screenshots", () => {
  test.skip(prefix === undefined, "set OVERDUE_SHOTS to write screenshots");
  for (const width of [390, 1280] as const) {
    for (const theme of THEMES) {
      test(`${String(width)} ${theme}`, async ({ page }) => {
        await open(page, width, theme);
        const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
        mkdirSync(directory, { recursive: true });
        const message = page.locator(".message", { has: page.locator("[data-overdue='true']") });
        await message.first().screenshot({
          path: join(directory, `${prefix ?? "shot"}-chat-${String(width)}-${theme}.png`),
        });
        await page.getByRole("button", { name: /^Questions/ }).click();
        const card = page.locator(".question-item").first();
        const toggle = card.locator(".question-toggle");
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        await card.screenshot({
          path: join(directory, `${prefix ?? "shot"}-questions-${String(width)}-${theme}.png`),
        });
      });
    }
  }
});

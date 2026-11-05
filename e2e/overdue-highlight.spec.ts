// The overdue due line is one shared tinted highlight in the chat message and on the Questions
// card (issue #97): no underline, a visible tint, and the "! " prefix; a due date that is not
// overdue stays plain. Synthetic data only. The "@csp" tag also runs these in WebKit.
// Screenshots: OVERDUE_SHOTS=<prefix> PLAYWRIGHT_SCREENSHOT_DIR=<dir> writes
// <prefix>-<place>-<width>-<theme>.png.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { ja } from "../src/i18n/ja";
import { zhTW } from "../src/i18n/zh-TW";
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
    // The theme's error colour as the browser resolves it, whatever notation the token uses.
    const probe = document.createElement("span");
    probe.style.color = "var(--error)";
    document.body.append(probe);
    const error = getComputedStyle(probe).color;
    probe.remove();
    const box = node.getBoundingClientRect();
    const container = (node.parentElement ?? node).getBoundingClientRect();
    return {
      color: own.color,
      error,
      width: box.width,
      containerWidth: container.width,
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
        expect(overdue.color).toBe(overdue.error);
        const normal = await style(plain);
        expect(normal.background).toBe("rgba(0, 0, 0, 0)");
        expect(normal.prefix === "none" || normal.prefix === "normal").toBe(true);
        expect(normal.color).not.toBe(normal.error);
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
        expect(chipStyle.color).toBe(chipStyle.error);
        const toggle = card.locator(".question-toggle");
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        const due = card.locator(".question-due[data-overdue='true']");
        await expect(due).toBeVisible();
        const dueStyle = await style(due);
        expect(dueStyle.underline).toBe("none");
        expect(dueStyle.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(dueStyle.prefix).toContain("!");
        expect(dueStyle.color).toBe(dueStyle.error);
        // A snug chip like the chat line, not a bar across the card.
        expect(dueStyle.width).toBeLessThan(dueStyle.containerWidth - 8);
        // A due date that is not overdue stays plain on the card too.
        const later = page.locator(".question-item", { hasText: "And what comes after that?" });
        const laterToggle = later.locator(".question-toggle");
        if ((await laterToggle.getAttribute("aria-expanded")) !== "true") await laterToggle.click();
        const plain = later.locator(".question-due[data-overdue='false']");
        await expect(plain).toBeVisible();
        const plainStyle = await style(plain);
        expect(plainStyle.background).toBe("rgba(0, 0, 0, 0)");
        expect(plainStyle.prefix === "none" || plainStyle.prefix === "normal").toBe(true);
        expect(plainStyle.color).not.toBe(plainStyle.error);
        await expect(later.locator(".shared-overdue")).toHaveCount(0);
      });
    });
  }
}

// Long translations wrap inside the tinted block instead of overflowing the phone.
for (const [locale, name, messages] of [
  ["ja", "Japanese", ja],
  ["zh-TW", "Traditional Chinese", zhTW],
] as const) {
  test.describe(`${name} at 390 px @csp`, () => {
    test.use({ locale });

    test("the tinted lines wrap inside the card @csp", async ({ page }) => {
      await open(page, 390, "paper");
      const chat = page.locator("[data-overdue='true']").first();
      await expect(chat).toBeVisible();
      const inChat = await style(chat);
      expect(inChat.color).toBe(inChat.error);
      expect(inChat.width).toBeLessThanOrEqual(inChat.containerWidth);
      const shots = process.env.OVERDUE_SHOTS;
      const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
      if (shots !== undefined) {
        mkdirSync(directory, { recursive: true });
        await page
          .locator(".message", { has: page.locator("[data-overdue='true']") })
          .first()
          .screenshot({ path: join(directory, `${shots}-chat-390-${locale}.png`) });
      }
      await page.getByRole("button", { name: messages["nav.back"] }).click();
      await page.getByRole("button", { name: new RegExp(`^${messages["nav.questions"]}`) }).click();
      const card = page.locator(".question-item").first();
      const toggle = card.locator(".question-toggle");
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      const due = card.locator(".question-due[data-overdue='true']");
      await expect(due).toBeVisible();
      if (shots !== undefined)
        await card.screenshot({ path: join(directory, `${shots}-questions-390-${locale}.png`) });
      const onCard = await style(due);
      expect(onCard.color).toBe(onCard.error);
      expect(onCard.width).toBeLessThanOrEqual(onCard.containerWidth);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
    });
  });
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
        if (width === 390)
          await page.getByRole("button", { name: "Back to conversations" }).click();
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

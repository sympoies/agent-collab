// On a phone the topic's name and its back control stay at the top of the screen while the
// messages scroll, the system back gesture leaves a topic for the topic list, and the floating
// "jump to latest" control never covers a message. Synthetic data only. The "@csp" tag also runs
// these in the WebKit project (see playwright.config.ts).

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { en } from "../src/i18n/catalog";
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
        n === 0 ? { type: "question", needs: "answer", to: "bob-agent" } : {},
        `Message number ${String(n + 1)}.\n\nA second line so each message is tall enough to scroll.`,
      ),
    })),
  ],
});

async function openTopic(page: Page) {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "#general", exact: true }).click();
  await expect(page.getByText(`Message number ${String(COUNT)}.`)).toBeVisible();
}

const scrollToBottom = (page: Page) =>
  page.locator(".conversation").evaluate((pane) => {
    pane.scrollTop = pane.scrollHeight;
  });

test.describe("the phone topic bar @csp", () => {
  test("stays at the top and goes back after scrolling to the latest message @csp", async ({
    page,
  }) => {
    await openTopic(page);
    await scrollToBottom(page);
    const bar = page.locator(".topic-bar");
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("heading", { name: "#general" })).toBeInViewport();
    const pane = await page.locator(".conversation").boundingBox();
    const box = await bar.boundingBox();
    expect(box?.y).toBeGreaterThanOrEqual((pane?.y ?? 0) - 1);
    expect(box?.y).toBeLessThanOrEqual((pane?.y ?? 0) + 1);
    const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: join(directory, "phone-topic-bottom.png") });
    await bar.getByRole("button", { name: en["nav.back"] }).click();
    await expect(page.getByRole("button", { name: "#general", exact: true })).toBeVisible();
    await expect(page.locator(".conversation")).toBeHidden();
  });

  test("system back returns from a topic to the list and a reload keeps working @csp", async ({
    page,
  }) => {
    await page.route("**/hosted-snapshot.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const before = await page.evaluate(() => history.length);
    await page.getByRole("button", { name: "#general", exact: true }).click();
    await expect(page.locator(".conversation")).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(before + 1);

    await page.goBack();
    await expect(page.locator(".conversation")).toBeHidden();
    await expect(page.getByRole("button", { name: "#general", exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");

    await page.getByRole("button", { name: "#general", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "#general", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "#general", exact: true }).click();
    await expect(page.getByText(`Message number ${String(COUNT)}.`)).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("button", { name: "#general", exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("the jump to latest control never covers the last message @csp", async ({ page }) => {
    await openTopic(page);
    await scrollToBottom(page);
    const jump = page.locator(".jump-to-latest");
    await expect(jump).toBeVisible();
    const button = await jump.boundingBox();
    const last = await page.locator(".message").last().boundingBox();
    expect(button).not.toBeNull();
    expect(last).not.toBeNull();
    if (button === null || last === null) return;
    const overlaps =
      button.x < last.x + last.width &&
      button.x + button.width > last.x &&
      button.y < last.y + last.height &&
      button.y + button.height > last.y;
    expect(overlaps).toBe(false);
  });

  test("leaves no history entry behind after Jump to latest and back @csp", async ({ page }) => {
    await openTopic(page);
    await page.getByRole("link", { name: en["nav.jumpLatest"] }).click();
    await page.locator(".topic-bar").getByRole("button", { name: en["nav.back"] }).click();
    await expect(page.locator(".conversation")).toBeHidden();
    // The next system back leaves the viewer; it must not reopen the topic.
    await page.goBack();
    await expect(page.locator(".conversation")).toBeHidden();
  });

  test("opening a question from Questions and going back leaves no entry behind @csp", async ({
    page,
  }) => {
    await openTopic(page);
    await page.locator(".topic-bar").getByRole("button", { name: en["nav.back"] }).click();
    await page.getByRole("button", { name: /^Questions/ }).click();
    await page.locator(".question-link").first().click();
    await expect(page.locator("#conversation-heading")).toHaveText("#general");
    await page.locator(".topic-bar").getByRole("button", { name: en["nav.back"] }).click();
    await expect(page.locator(".conversation")).toBeHidden();
    await page.goBack();
    await expect(page.locator(".conversation")).toBeHidden();
  });

  test("system back from inside a topic after a link keeps the topic open @csp", async ({
    page,
  }) => {
    await openTopic(page);
    await page.getByRole("link", { name: en["nav.jumpLatest"] }).click();
    await page.goBack();
    await expect(page.locator(".conversation")).toBeVisible();
    await page.goBack();
    await expect(page.locator(".conversation")).toBeHidden();
    await expect(page.getByRole("button", { name: "#general", exact: true })).toBeVisible();
  });

  test("two fragment entries do not close the topic on system back @csp", async ({ page }) => {
    await openTopic(page);
    await page.evaluate(() => {
      window.location.hash = "#first";
    });
    await page.evaluate(() => {
      window.location.hash = "#second";
    });
    await page.goBack();
    await expect(page.locator(".conversation")).toBeVisible();
    await page.goBack();
    await expect(page.locator(".conversation")).toBeVisible();
  });

  test("the global header shrinks while a topic is open and returns on the list @csp", async ({
    page,
  }) => {
    await openTopic(page);
    await expect(page.locator(".bar h1")).toBeHidden();
    await expect(page.locator(".source-indicator")).toBeHidden();
    await page.locator(".topic-bar").getByRole("button", { name: en["nav.back"] }).click();
    await expect(page.locator(".bar h1")).toBeVisible();
    await expect(page.locator(".source-indicator")).toBeVisible();
  });

  test("a wide screen keeps the global header and the status line above the range @csp", async ({
    page,
  }) => {
    await page.route("**/hosted-snapshot.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "#general", exact: true }).click();
    await expect(page.locator(".conversation")).toBeVisible();
    await expect(page.locator(".bar h1")).toBeVisible();
    await expect(page.locator(".source-indicator")).toBeVisible();
    await expect(page.locator(".topic-menu")).toHaveCount(0);
    await expect(page.locator(".range-bar")).toBeVisible();
  });
});

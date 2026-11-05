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
const LONG_TOPIC = "a-topic-name-that-is-long-enough-to-wrap-without-overflow-at-phone-width";
const LONG_ID = `2026-11-04T0950-alice-agent-${LONG_TOPIC}-01`;
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
        n === 0
          ? { type: "question", needs: "answer", to: "bob-agent" }
          : n === 1
            ? { reply_to: id(1) }
            : {},
        `Message number ${String(n + 1)}.\n\nA second line so each message is tall enough to scroll.`,
      ),
    })),
    {
      path: `topics/${LONG_TOPIC}/inbox/2026-11/${LONG_ID}.md`,
      text: messageText(LONG_ID, "alice-agent", LONG_TOPIC, {}, "A message in a long topic."),
    },
  ],
});

async function openTopic(page: Page, afterOtherPage = false) {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  // A page of another origin before the viewer tells leaving the viewer from staying in it.
  if (afterOtherPage) await page.goto("data:text/html,<p>before</p>");
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
    // The topic screen comes back (phone-reload.spec.ts); back still leaves it for the list.
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

  const barBack = (page: Page) =>
    page.locator(".topic-bar").getByRole("button", { name: en["nav.back"] });
  const listRow = (page: Page) => page.getByRole("button", { name: "#general", exact: true });

  // Links inside the viewer add no history entry, so one system back always closes the topic and
  // the one after it leaves the viewer for the page the reader came from.
  test("Jump to latest adds no history entry and system back closes the topic @csp", async ({
    page,
  }) => {
    await openTopic(page, true);
    const before = await page.evaluate(() => history.length);
    await page.getByRole("link", { name: en["nav.jumpLatest"] }).click();
    expect(await page.evaluate(() => history.length)).toBe(before);
    await page.goBack();
    await expect(page.locator(".conversation")).toBeHidden();
    await expect(listRow(page)).toBeVisible();
    const inApp = page.url();
    await page.goBack();
    expect(page.url()).not.toBe(inApp);
    expect(page.url()).toMatch(/^data:/);
  });

  test("Questions and Files have no Jump to latest link to leave the topic with @csp", async ({
    page,
  }) => {
    await openTopic(page, true);
    await barBack(page).click();
    for (const name of [/^Questions/, /^Files/]) {
      await page.getByRole("button", { name }).click();
      await expect(barBack(page)).toBeVisible();
      await expect(page.getByRole("link", { name: en["nav.jumpLatest"] })).toHaveCount(0);
      const before = await page.evaluate(() => history.length);
      // A plain link to a missing target does nothing: no entry, the view stays.
      await page.evaluate(() => {
        const link = document.createElement("a");
        link.href = "#missing";
        link.textContent = "missing";
        document.querySelector(".conversation")?.append(link);
        link.click();
      });
      expect(await page.evaluate(() => history.length)).toBe(before);
      await expect(page.locator(".conversation")).toBeVisible();
      await barBack(page).click();
      await expect(listRow(page)).toBeVisible();
    }
  });

  test("the bar's back after Jump to latest leaves the history as it was @csp", async ({
    page,
  }) => {
    await openTopic(page, true);
    await page.getByRole("link", { name: en["nav.jumpLatest"] }).click();
    await expect(barBack(page)).toBeVisible();
    await barBack(page).click();
    await expect(listRow(page)).toBeVisible();
    // Opening the topic again and going back twice stays in the viewer the first time.
    await listRow(page).click();
    await barBack(page).click();
    await expect(listRow(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    await listRow(page).click();
    await page.goBack();
    await expect(listRow(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    const inApp = page.url();
    await page.goBack();
    expect(page.url()).not.toBe(inApp);
    expect(page.url()).toMatch(/^data:/);
  });

  test("a question opened from Questions leaves no entry behind @csp", async ({ page }) => {
    await openTopic(page, true);
    await barBack(page).click();
    await page.getByRole("button", { name: /^Questions/ }).click();
    await page.locator(".question-link").first().click();
    await expect(page.locator("#conversation-heading")).toHaveText("#general");
    await expect(barBack(page)).toBeVisible();
    await barBack(page).click();
    await expect(page.locator(".conversation")).toBeHidden();
    await listRow(page).click();
    await page.goBack();
    await expect(listRow(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
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

  test("a quote link moves the focus to the quoted message without a history entry @csp", async ({
    page,
  }) => {
    await openTopic(page);
    const before = { length: await page.evaluate(() => history.length), url: page.url() };
    const quote = page.locator(".quote").first();
    await quote.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(`#msg-${id(1)}`)).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(before.length);
    expect(page.url()).toBe(before.url);
  });

  // The title is one line of text: a long name is cut with an ellipsis, never broken mid-word.
  const expectOneLine = async (page: Page) => {
    const heading = page.locator(".topic-bar h2");
    const { height, fontSize } = await heading.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      fontSize: parseFloat(getComputedStyle(node).fontSize),
    }));
    expect(height).toBeLessThanOrEqual(fontSize * 1.7);
  };

  test("the bar title is one line for All and for a long topic name @csp", async ({ page }) => {
    await openTopic(page);
    await barBack(page).click();
    await page.getByRole("button", { name: en["nav.all"], exact: true }).click();
    await expect(page.locator(".topic-bar h2")).toHaveText(en["heading.all"]);
    await expectOneLine(page);
    await barBack(page).click();
    await page.getByRole("button", { name: `#${LONG_TOPIC}`, exact: true }).click();
    await expect(page.locator(".topic-bar h2")).toHaveText(`#${LONG_TOPIC}`);
    await expectOneLine(page);
  });

  test("the back control is a proper touch target @csp", async ({ page }) => {
    await openTopic(page);
    const box = await barBack(page).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });
});

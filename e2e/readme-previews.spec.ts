import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "en-US", timezoneId: "UTC" });

const OVERDUE_QUESTION_TEXT = "Please review the field draft in refs.";

async function blockExternalRequests(page: Page): Promise<string[]> {
  const external: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      external.push(url.origin);
      await route.abort();
    } else {
      await route.continue();
    }
  });
  return external;
}

async function openOfflineDemo(page: Page, expandQuestionTree = true): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved repository" }).click();
  await page.getByRole("button", { name: "Open offline demo" }).click();
  await expect(page.getByRole("heading", { name: "Demo repository" })).toBeVisible();
  if (expandQuestionTree) {
    await page.getByRole("button", { name: /^Questions\s+\d+ open$/ }).click();
    await expect(page.locator(".questions-tree")).toBeVisible();
  }
  await page.getByRole("button", { name: /^#api/ }).click();
  await expect(
    page.locator('.message[data-type="question"]').filter({ hasText: OVERDUE_QUESTION_TEXT }),
  ).toBeVisible();
  await expect(page.locator(".message")).toHaveCount(4);
}

async function scrollConversationToLatest(page: Page, checkButtonBehavior = false): Promise<void> {
  const main = page.getByRole("main");
  const jumpButton = page.locator(".jump-to-latest");
  await main.evaluate((element) => {
    element.style.scrollBehavior = "auto";
  });
  if (checkButtonBehavior) {
    await main.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(jumpButton).toHaveCount(1);
  }
  const bottom = await main.evaluate((element) => {
    const target = element.scrollHeight - element.clientHeight;
    element.scrollTop = target;
    return target;
  });
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(bottom);
  await expect(jumpButton).toHaveCount(0);
}

test("capture the fictional desktop and phone README previews", async ({ page }) => {
  const externalRequests = await blockExternalRequests(page);
  await page.clock.setFixedTime(new Date("2026-11-06T12:00:00.000Z"));
  await page.addInitScript(() => {
    localStorage.setItem("agent-collab-viewer.locale", "en");
    if (localStorage.getItem("agent-collab-viewer.theme") === null) {
      localStorage.setItem("agent-collab-viewer.theme", "night-owl");
    }
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await openOfflineDemo(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night-owl");
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Questions\s+\d+ open$/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByRole("button", { name: "Files", exact: true })).toBeVisible();

  const overdueQuestion = page
    .locator('.message[data-type="question"]')
    .filter({ hasText: OVERDUE_QUESTION_TEXT });
  const acknowledgement = page
    .locator(".message")
    .filter({ hasText: "Received; answer expected by Friday." });
  await expect(page.locator(".questions-tree .count").first()).toHaveText(/\d+/);
  await expect(page.locator(".topic-name").filter({ hasText: "api" })).toBeVisible();
  await expect(overdueQuestion.locator(".due.shared-overdue")).toBeVisible();
  await expect(overdueQuestion.locator(".shared-recipient").first()).toBeVisible();
  await scrollConversationToLatest(page, true);
  await expect(overdueQuestion).toBeInViewport({ ratio: 1 });
  await expect(overdueQuestion.locator(".due.shared-overdue")).toBeInViewport({ ratio: 1 });
  await expect(overdueQuestion.locator(".shared-recipient").first()).toBeInViewport({ ratio: 1 });
  await expect(acknowledgement).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  const previewDirectory = process.env.README_PREVIEW_DIR;
  if (previewDirectory !== undefined) {
    mkdirSync(previewDirectory, { recursive: true });
    await page.screenshot({ path: join(previewDirectory, "desktop-night-owl-1280.png") });
  }

  await page.evaluate(() => {
    localStorage.setItem("agent-collab-viewer.theme", "paper");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await openOfflineDemo(page, false);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(page.locator(".workspace")).toHaveAttribute("data-mobile-view", "conversation");
  await expect(page.locator(".topic-bar")).toBeVisible();
  await scrollConversationToLatest(page);
  await expect(overdueQuestion.locator(".shared-recipient").first()).toBeInViewport({ ratio: 1 });
  await expect(overdueQuestion.locator(".due.shared-overdue")).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  if (previewDirectory !== undefined) {
    await page.screenshot({ path: join(previewDirectory, "phone-paper-390.png") });
  }
  expect(externalRequests).toEqual([]);
});

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

test.use({ locale: "en-US", timezoneId: "UTC" });

const QUESTION_TEXT = "Please review the field draft in refs.";

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

async function openOfflineDemo(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved repository" }).click();
  await page.getByRole("button", { name: "Open offline demo" }).click();
  await expect(page.getByRole("heading", { name: "Demo repository" })).toBeVisible();
  await page.getByRole("button", { name: /^#api/ }).click();
  await expect(
    page.locator('.message[data-type="question"]').filter({ hasText: QUESTION_TEXT }),
  ).toBeVisible();
  await expect(page.locator(".message")).toHaveCount(4);
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

  await page.setViewportSize({ width: 1280, height: 800 });
  await openOfflineDemo(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night-owl");
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Questions\s+\d+ open$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Files", exact: true })).toBeVisible();
  const question = page
    .locator('.message[data-type="question"]')
    .filter({ hasText: QUESTION_TEXT });
  await expect(question.locator(".shared-recipient").first()).toBeVisible();
  await page.getByRole("main").press("Home");
  await page.getByRole("main").evaluate((main) => {
    main.scrollTop += 52;
  });
  await expect(question).toBeInViewport();
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
  await openOfflineDemo(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(page.locator(".workspace")).toHaveAttribute("data-mobile-view", "conversation");
  await expect(page.locator(".topic-bar")).toBeVisible();
  await page.getByRole("main").press("Home");
  await page.getByRole("main").evaluate((main) => {
    main.scrollTop += 32;
  });
  await expect(question).toBeInViewport();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  if (previewDirectory !== undefined) {
    await page.screenshot({ path: join(previewDirectory, "phone-paper-390.png") });
  }
  expect(externalRequests).toEqual([]);
});

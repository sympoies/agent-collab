import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { topicSnapshot } from "../tests/topic-snapshot-fixture";

test("the phone toolbar stays at the right on each conversation page @csp", async ({ page }) => {
  const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR;
  if (directory === undefined) throw new Error("PLAYWRIGHT_SCREENSHOT_DIR is required");
  mkdirSync(directory, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open saved repository" }).click();
  await page.getByRole("button", { name: "Open offline demo" }).click();

  for (const [pageName, name] of [
    ["all", /^All$/],
    ["questions", /^Questions/],
    ["files", /^Files/],
  ] as const) {
    if (pageName !== "all") {
      await page
        .locator(".topic-bar")
        .getByRole("button", { name: "Back to conversations" })
        .click();
    }
    await page.getByRole("button", { name }).click();
    await expect(page.locator(".conversation")).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More" })).toBeVisible();
    const bar = page.locator(".bar");
    const bounds = await bar.evaluate((node) => {
      const root = node.getBoundingClientRect();
      const actions = node.querySelector(".bar-actions")?.getBoundingClientRect();
      return {
        paddedRight: root.right - Number.parseFloat(getComputedStyle(node).paddingRight),
        actionsRight: actions?.right,
      };
    });
    expect(bounds.actionsRight).toBeCloseTo(bounds.paddedRight, 0);
    await bar.screenshot({ path: join(directory, `issue-130-phone-before-${pageName}.png`) });
  }
});

test("the phone toolbar stays at the right on a topic conversation @csp", async ({ page }) => {
  const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR;
  if (directory === undefined) throw new Error("PLAYWRIGHT_SCREENSHOT_DIR is required");
  mkdirSync(directory, { recursive: true });
  const snapshot = await topicSnapshot();
  await page.route("**/hosted-snapshot.json", (route) => route.fulfill({ json: snapshot }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "#api", exact: true }).click();
  await expect(page.locator(".conversation")).toBeVisible();
  const bar = page.locator(".bar");
  const bounds = await bar.evaluate((node) => {
    const root = node.getBoundingClientRect();
    const actions = node.querySelector(".bar-actions")?.getBoundingClientRect();
    return {
      paddedRight: root.right - Number.parseFloat(getComputedStyle(node).paddingRight),
      actionsRight: actions?.right,
    };
  });
  expect(bounds.actionsRight).toBeCloseTo(bounds.paddedRight, 0);
  await bar.screenshot({ path: join(directory, "issue-130-phone-before-topic.png") });
});

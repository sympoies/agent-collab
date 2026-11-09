// A load or reload shows no focus ring until the reader touches or presses a key; a real
// navigation still moves focus to the heading (or back to the last list row). Synthetic data
// only. The "@csp" tag also runs these in WebKit.

import { expect, test } from "@playwright/test";

import { en } from "../src/i18n/catalog";
import { messageText } from "../tests/support";

const ID = "2026-11-04T0901-alice-agent-api-01";
const snapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:59:00.000Z",
  revision: "r1",
  files: [
    { path: ".agent-collab", text: "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n" },
    {
      path: `inbox/2026-11/${ID}.md`,
      text: messageText(ID, "alice-agent", "api", { type: "info" }, "A message."),
    },
  ],
});

// A touch phone: a script focus without an earlier pointer or key matches :focus-visible.
test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });

const focusState = (page: import("@playwright/test").Page) =>
  page.evaluate(() => ({
    onHeading: document.activeElement?.id === "conversation-heading",
    active: document.activeElement?.tagName ?? "",
    visible: document.querySelectorAll(":focus-visible").length,
  }));

test.beforeEach(async ({ page }) => {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
});

test("a load with a conversation already open shows no focus ring @csp", async ({ page }) => {
  // The state a reload restores: the conversation screen was open.
  await page.addInitScript(() => {
    localStorage.setItem(
      `agent-collab-viewer.view:hosted:${location.origin}/`,
      JSON.stringify({ view: "chat", topic: null, conversation: true }),
    );
  });
  await page.goto("/");
  await expect(page.locator(".conversation")).toBeVisible();
  await expect(page.locator("#conversation-heading")).toBeVisible();
  // Give a delayed focus move (a 0 ms timer) the time it would need.
  await page.waitForTimeout(300);
  const state = await focusState(page);
  expect(state.onHeading).toBe(false);
  expect(state.visible).toBe(0);
});

test("opening a conversation from the list still moves focus to its heading @csp", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".topics")).toBeVisible();
  await page.getByRole("button", { name: en["nav.all"], exact: true }).click();
  await expect.poll(async () => (await focusState(page)).onHeading).toBe(true);
  // Going back to the list returns focus to the row that opened the conversation.
  await page.getByRole("button", { name: en["nav.back"] }).click();
  await expect(page.locator(".conversation")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.textContent.startsWith("All") ?? false))
    .toBe(true);
});

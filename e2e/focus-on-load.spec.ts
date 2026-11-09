// A phone that reloads with a conversation open must not draw a focus ring: focus moves only on a
// real navigation (issue #105). A hosted snapshot remembers the view across a reload: synthetic data only, no network. The
// "@csp" tag also runs these in WebKit.

import { expect, test, type Page } from "@playwright/test";

import { flat, MARKER, messageText } from "../tests/support";

const snapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:00:00.000Z",
  revision: "r1",
  files: [
    { path: ".agent-collab", text: `${MARKER}participants: alice-agent, bob-agent\n` },
    {
      path: flat("2026-10", 1, 1),
      text: messageText(
        "2026-10-01T0901-alice-agent-api-01",
        "alice-agent",
        "api",
        { type: "info", needs: "none", to: "bob-agent" },
        "A message to read.",
      ),
    },
  ],
});

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

async function openConversation(page: Page) {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByText("A message to read.")).toBeVisible();
}

const state = (page: Page) =>
  page.evaluate(() => ({
    active: document.activeElement?.id ?? document.activeElement?.tagName ?? "",
    ringed: document.querySelectorAll(":focus-visible").length,
  }));

test("a reload with a conversation open shows no focus ring @csp", async ({ page }) => {
  await openConversation(page);
  await page.reload();
  await expect(page.getByText("A message to read.")).toBeVisible();
  await page.waitForTimeout(250); // the old effect focused the heading in a timer
  const after = await state(page);
  expect(after.active).not.toBe("conversation-heading");
  expect(after.ringed).toBe(0);
});

test("opening a conversation from the list still focuses its heading @csp", async ({ page }) => {
  await openConversation(page);
  await expect(page.locator("#conversation-heading")).toBeFocused();
});

test("going back to the list still focuses the last topic button @csp", async ({ page }) => {
  await openConversation(page);
  await page.getByRole("button", { name: "Back to conversations" }).click();
  await expect(page.getByRole("button", { name: "All", exact: true })).toBeFocused();
});

test("a reload on the list moves no focus either @csp", async ({ page }) => {
  await openConversation(page);
  await page.getByRole("button", { name: "Back to conversations" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  expect((await state(page)).ringed).toBe(0);
});

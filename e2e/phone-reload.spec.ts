// On a phone, reloading inside a topic reopens that topic's screen, system back returns to the
// list, and reloading on the list stays on the list. Synthetic data only. The "@csp" tag also runs
// these in the WebKit project (see playwright.config.ts).

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
        {},
        `Message number ${String(n + 1)}.\n\nA second line so each message is tall enough to scroll.`,
      ),
    })),
  ],
});

const row = (page: Page) => page.getByRole("button", { name: "#general", exact: true });
const bar = (page: Page) => page.locator(".topic-bar");

async function start(page: Page) {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
}

test.describe("reloading on a phone @csp", () => {
  test("inside a topic reopens the topic screen at the latest message @csp", async ({ page }) => {
    await start(page);
    await row(page).click();
    await expect(page.getByText(`Message number ${String(COUNT)}.`)).toBeVisible();

    await page.reload();
    await expect(page.locator(".conversation")).toBeVisible();
    await expect(bar(page).getByRole("heading", { name: "#general" })).toBeVisible();
    await expect(page.getByText(`Message number ${String(COUNT)}.`)).toBeVisible();
    const pane = page.locator(".conversation");
    await expect
      .poll(() => pane.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThanOrEqual(1);

    // The system back gesture goes to the list, as before the reload.
    await page.goBack();
    await expect(page.locator(".conversation")).toBeHidden();
    await expect(row(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("on the list stays on the list, also after leaving a topic with the back control @csp", async ({
    page,
  }) => {
    await start(page);
    await page.reload();
    await expect(row(page)).toBeVisible();
    await expect(page.locator(".conversation")).toBeHidden();

    await row(page).click();
    await bar(page).getByRole("button", { name: en["nav.back"] }).click();
    await expect(row(page)).toBeVisible();
    await page.reload();
    await expect(row(page)).toBeVisible();
    await expect(page.locator(".conversation")).toBeHidden();
  });

  test("a topic that is gone falls back to the list @csp", async ({ page }) => {
    await start(page);
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => name.includes(".view:"));
      localStorage.setItem(
        key ?? "agent-collab-viewer.view:hosted",
        JSON.stringify({ view: "chat", topic: "removed", conversation: true }),
      );
    });
    await page.reload();
    await expect(row(page)).toBeVisible();
    await expect(page.locator(".conversation")).toBeHidden();
  });

  test("on a wide screen a reload keeps the topic as before @csp", async ({ page }) => {
    await start(page);
    await row(page).click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await expect(page.getByText(`Message number ${String(COUNT)}.`)).toBeVisible();
    await expect(row(page)).toHaveAttribute("aria-pressed", "true");
  });
});

// The toolbar's identity button: who the viewer is is chosen in the profile panel, not in a
// labelled select next to it. Synthetic data only. The "@csp" tag also runs these in the WebKit
// project (see playwright.config.ts).

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { en } from "../src/i18n/catalog";
import { messageText } from "../tests/support";

const QUESTION = "2026-11-04T0901-alice-agent-api-01";
const REPLY = "2026-11-04T0902-bob-agent-api-01";
const snapshot = (marker: string) =>
  JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-11-04T09:59:00.000Z",
    revision: "r1",
    files: [
      { path: ".agent-collab", text: marker },
      {
        path: `inbox/2026-11/${QUESTION}.md`,
        text: messageText(QUESTION, "alice-agent", "api", {
          type: "question",
          needs: "answer",
          to: "bob-agent",
        }),
      },
      {
        path: `inbox/2026-11/${REPLY}.md`,
        text: messageText(REPLY, "bob-agent", "api", { to: "alice-agent" }),
      },
    ],
  });
const ROSTER = "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n";

async function open(page: Page, width: number, marker = ROSTER) {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot(marker) }),
  );
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  // A phone shows the conversation list first.
  if (width < 721) await page.getByRole("button", { name: en["nav.all"], exact: true }).click();
  await expect(page.locator(".message").first()).toBeVisible();
}

const identity = (page: Page) => page.locator(".bar-actions .identity-button");

for (const width of [390, 1280]) {
  test.describe(`the identity button at ${String(width)} px @csp`, () => {
    test("replaces the Viewing as select and the profile button @csp", async ({ page }) => {
      await open(page, width);
      await expect(page.getByRole("combobox", { name: en["bar.viewingAs"] })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: en["profile.title"], exact: true }),
      ).toHaveCount(0);
      await expect(identity(page)).toBeVisible();
      if (width === 390) {
        // Only Refresh, the identity button and the More menu stay in the bar.
        await expect(page.locator(".bar-actions > *")).toHaveCount(3);
      }
    });

    test("chooses who the viewer is in the panel and closes with Escape @csp", async ({ page }) => {
      await open(page, width);
      // No own names: the hint is shown and the viewer is Observer.
      await expect(identity(page)).toHaveAccessibleName(new RegExp(en["bar.observer"]));
      await identity(page).click();
      const panel = page.getByRole("region", { name: en["profile.title"] });
      await expect(panel).toBeVisible();
      await panel.getByLabel(en["bar.viewingAs"]).selectOption("bob-agent");
      await expect(identity(page)).toHaveAccessibleName(/bob-agent/);
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(identity(page)).toBeFocused();
      // Bob is addressed by the question: it is waiting for them.
      await expect(page.locator(".group[data-own='true']")).toHaveCount(1);
      if (width < 721) await page.getByRole("button", { name: en["nav.back"] }).click();
      await page.getByRole("button", { name: /^Questions/ }).click();
      await expect(page.getByText(en["questions.waiting"]).first()).toBeVisible();
    });

    test("shows the first-run hint once, also after a reload @csp", async ({ page }) => {
      await open(page, width);
      const hint = page.locator(".identity-hint");
      await expect(hint).toBeVisible();
      await hint.getByRole("button").click();
      await expect(hint).toBeHidden();
      await page.reload();
      await expect(identity(page)).toBeVisible();
      await expect(hint).toHaveCount(0);
    });

    test("shows no hint when the marker names no participants @csp", async ({ page }) => {
      await open(page, width, "collab-protocol: 1\n");
      await expect(identity(page)).toBeVisible();
      await expect(page.locator(".identity-hint")).toHaveCount(0);
    });
  });
}

// Screenshots for review: the toolbar in both themes at phone, tablet and desktop widths. The test
// asserts nothing about the new controls, so it also runs on the previous version for "before".
for (const scheme of ["light", "dark"] as const) {
  for (const width of [390, 768, 1280]) {
    test(`screenshots ${scheme} ${String(width)}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, width);
      const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
      mkdirSync(directory, { recursive: true });
      await page.screenshot({
        path: join(directory, `toolbar-${scheme}-${String(width)}.png`),
        clip: { x: 0, y: 0, width, height: 260 },
      });
    });
  }
}

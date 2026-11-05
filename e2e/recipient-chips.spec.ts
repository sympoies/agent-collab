// Recipients are colored like senders, topic chips are one neutral style that is hidden inside a
// single topic, and avatar initials come from the display name. Synthetic data only. The "@csp"
// tag also runs these in WebKit.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "../src/i18n/catalog";
import { messageText } from "../tests/support";

const TO_BOB = "2026-11-04T0901-alice-agent-api-01";
const TO_ALICE = "2026-11-04T0902-bob-agent-api-01";
const TO_ALL = "2026-11-04T0903-bob-agent-ops-01";
const TO_GHOST = "2026-11-04T0904-alice-agent-ops-01";
const QUESTION = "2026-11-04T0905-alice-agent-api-02";
const body = (id: string, from: string, topic: string, fields: Record<string, string>) => ({
  path: `inbox/2026-11/${id}.md`,
  text: messageText(id, from, topic, fields, `Message ${id}.`),
});
const snapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:59:00.000Z",
  revision: "r1",
  files: [
    { path: ".agent-collab", text: "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n" },
    body(TO_BOB, "alice-agent", "api", { to: "bob-agent" }),
    body(TO_ALICE, "bob-agent", "api", { to: "alice-agent" }),
    body(TO_ALL, "bob-agent", "ops", { to: "all" }),
    body(TO_GHOST, "alice-agent", "ops", { to: "ghost-agent" }),
    body(QUESTION, "alice-agent", "api", { type: "question", needs: "answer", to: "bob-agent" }),
  ],
});

async function open(page: Page, width: number, scheme: "light" | "dark") {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  // A phone shows the conversation list first.
  if (width < 721) await page.getByRole("button", { name: en["nav.all"], exact: true }).click();
  await expect(page.locator(".message").first()).toBeVisible();
}

const color = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).color);
const chip = (page: Page, id: string) => page.locator(`#msg-${id} .meta .recipient`);

for (const scheme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test.describe(`recipient and topic chips, ${scheme} ${String(width)} px @csp`, () => {
      test("a recipient has the person's color, and the viewer's name is filled @csp", async ({
        page,
      }) => {
        await open(page, width, scheme);
        // The recipient of the first message is bob: his chip has the color of his sender name.
        const bobSender = page.locator(".sender", { hasText: /^bob-agent$/ }).first();
        expect(await color(chip(page, TO_BOB))).toBe(await color(bobSender));
        // The viewer (no own names here: Observer) is nobody; choose alice and her chip is filled.
        await page.locator(".bar-actions .identity-button").click();
        await page
          .getByRole("region", { name: en["profile.title"] })
          .getByLabel(en["bar.viewingAs"])
          .selectOption("alice-agent");
        await page.keyboard.press("Escape");
        await expect(chip(page, TO_ALICE)).toHaveAttribute("data-self", "true");
        await expect(chip(page, TO_BOB)).not.toHaveAttribute("data-self", "true");
        const filled = await chip(page, TO_ALICE).evaluate(
          (node) => getComputedStyle(node).backgroundColor,
        );
        expect(filled).not.toBe("rgba(0, 0, 0, 0)");
      });

      test("everyone and an unknown recipient are neutral @csp", async ({ page }) => {
        await open(page, width, scheme);
        for (const [id, kind] of [
          [TO_ALL, "everyone"],
          [TO_GHOST, "unknown"],
        ] as const) {
          await expect(chip(page, id)).toHaveAttribute("data-kind", kind);
          await expect(chip(page, id)).not.toHaveAttribute("data-slot", /.*/);
        }
        const neutral = await color(chip(page, TO_ALL));
        expect(await color(chip(page, TO_GHOST))).toBe(neutral);
        expect(neutral).not.toBe(await color(chip(page, TO_BOB)));
      });

      test("Questions colors the recipient like the sender @csp", async ({ page }) => {
        await open(page, width, scheme);
        const bobColor = await color(chip(page, TO_BOB));
        if (width < 721) await page.getByRole("button", { name: en["nav.back"] }).click();
        await page.getByRole("button", { name: /^Questions/ }).click();
        const toggle = page.locator(".question-toggle").first();
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
        const recipient = page.locator(".question-body .recipient").first();
        await expect(recipient).toHaveAttribute("data-slot", /\d/);
        expect(await color(recipient)).toBe(bobColor);
      });

      test("the topic chip is one neutral style, and absent inside a single topic @csp", async ({
        page,
      }) => {
        await open(page, width, scheme);
        const chips = page.locator(".group .topic");
        await expect(chips.first()).toBeVisible();
        const styles = await chips.evaluateAll((nodes) =>
          nodes.map((node) => {
            const style = getComputedStyle(node);
            return `${style.color}|${style.borderTopColor}|${style.backgroundColor}`;
          }),
        );
        expect(new Set(styles).size).toBe(1);
        if (width < 721) await page.getByRole("button", { name: en["nav.back"] }).click();
        await page.locator(".topics button", { hasText: "#api" }).click();
        await expect(page.locator(".message").first()).toBeVisible();
        await expect(page.locator(".group .topic")).toHaveCount(0);
      });

      test("avatar initials follow the display name, also after a reload @csp", async ({
        page,
      }) => {
        await open(page, width, scheme);
        const avatar = page.locator(".group .avatar").first();
        await expect(avatar).toHaveText("AA");
        await page.locator(".bar-actions .identity-button").click();
        const panel = page.getByRole("region", { name: en["profile.title"] });
        const name = panel.getByLabel("Display name for alice-agent", { exact: true });
        await name.fill("Alice Smith");
        await name.blur();
        await expect(avatar).toHaveText("AS");
        await page.reload();
        // A reload on a phone reopens the screen it was on; the list needs All opened.
        const all = page.getByRole("button", { name: en["nav.all"], exact: true });
        if (await all.isVisible()) await all.click();
        await expect(page.locator(".group .avatar").first()).toHaveText("AS");
      });

      test(`screenshots ${scheme} ${String(width)}`, async ({ page }) => {
        await open(page, width, scheme);
        const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
        mkdirSync(directory, { recursive: true });
        await page.screenshot({
          path: join(directory, `chips-${scheme}-${String(width)}.png`),
        });
      });
    });
  }
}

// The narrowest phone of the acceptance criteria: chips wrap and the page does not scroll sideways.
for (const scheme of ["light", "dark"] as const) {
  test(`recipient chips wrap without sideways scrolling at 360 px, ${scheme} @csp`, async ({
    page,
  }) => {
    await open(page, 360, scheme);
    await expect(chip(page, TO_BOB)).toBeVisible();
    await expect(chip(page, TO_GHOST)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    // The page can hide an overflow inside the conversation pane, so measure the chips and the
    // pane itself: every chip ends inside the viewport and the pane has nothing to scroll sideways.
    const rights = await page
      .locator(".meta .recipient")
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
    expect(rights.length).toBeGreaterThan(0);
    for (const right of rights) expect(right).toBeLessThanOrEqual(360);
    const pane = await page
      .locator(".conversation")
      .evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(pane).toBeLessThanOrEqual(0);
  });
}

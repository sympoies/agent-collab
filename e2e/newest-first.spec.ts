// The Questions page and the Files page list the newest first and open at the top; the chat keeps
// its landing at the latest message, and switching between them leaves no stale scroll position.
// Synthetic data only. The "@csp" tag also runs these in WebKit.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { en } from "../src/i18n/catalog";
import { messageText } from "../tests/support";

const COUNT = 14;
const id = (n: number) => `2026-11-04T09${String(n).padStart(2, "0")}-alice-agent-api-01`;
const snapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:59:00.000Z",
  revision: "r1",
  files: [
    { path: ".agent-collab", text: "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n" },
    ...Array.from({ length: COUNT }, (_, n) => ({
      path: `inbox/2026-11/${id(n)}.md`,
      text: messageText(
        id(n),
        "alice-agent",
        "api",
        {
          type: "question",
          to: "bob-agent",
          needs: "answer",
          refs: `topics/api/file-${String(n).padStart(2, "0")}.txt`,
        },
        `Question number ${String(n).padStart(2, "0")}.\n\nA second paragraph so each card is tall enough to scroll.`,
      ),
    })),
  ],
});

async function open(page: Page, width: number, scheme: "light" | "dark") {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 700 });
  await page.goto("/");
  await expect(page.locator(".topics")).toBeVisible();
}

const views = (page: Page) => page.locator(".topics > button");
const goTo = async (page: Page, width: number, label: RegExp) => {
  // On a phone the list is a screen of its own: back to it before choosing.
  if (width < 721 && (await page.locator(".conversation").isVisible())) {
    await page.getByRole("button", { name: en["nav.back"] }).click();
  }
  await views(page).filter({ hasText: label }).first().click();
};
const scroll = (page: Page) =>
  page.locator(".conversation").evaluate((node) => ({
    top: node.scrollTop,
    max: node.scrollHeight - node.clientHeight,
  }));

for (const scheme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test.describe(`newest first, opening at the top, ${scheme} ${String(width)} px @csp`, () => {
      test("Questions lists the newest first and opens at the top @csp", async ({ page }) => {
        await open(page, width, scheme);
        await goTo(page, width, /^Questions/);
        const texts = page.locator(".question-text");
        await expect(texts).toHaveCount(COUNT);
        await expect(texts.first()).toContainText(`Question number ${String(COUNT - 1)}`);
        await expect(texts.last()).toContainText("Question number 00");
        const state = await scroll(page);
        expect(state.max).toBeGreaterThan(200);
        expect(state.top).toBe(0);
      });

      test("Files lists the newest first and opens at the top @csp", async ({ page }) => {
        await open(page, width, scheme);
        await goTo(page, width, /^Files/);
        const names = page.locator(".file-name");
        await expect(names.first()).toContainText(`file-${String(COUNT - 1)}`);
        await expect(names.last()).toContainText("file-00");
        const state = await scroll(page);
        expect(state.max).toBeGreaterThan(200);
        expect(state.top).toBe(0);
      });

      test("the chat still opens at the latest message, and no scroll position goes stale @csp", async ({
        page,
      }) => {
        await open(page, width, scheme);
        await goTo(page, width, /^All/);
        await expect(page.locator(".message").first()).toBeVisible();
        const atBottom = async () => {
          const state = await scroll(page);
          return state.max - state.top <= 2;
        };
        await expect.poll(atBottom).toBe(true);
        // A list page after the chat bottom: the top, not the old position.
        await goTo(page, width, /^Questions/);
        await expect(page.locator(".question-text").first()).toBeVisible();
        await expect.poll(async () => (await scroll(page)).top).toBe(0);
        // Scrolled down in the list, then the chat again: the latest message once more.
        await page.locator(".conversation").evaluate((node) => {
          node.scrollTo({ top: 400, behavior: "instant" });
        });
        await goTo(page, width, /^All/);
        await expect(page.locator(".message").first()).toBeVisible();
        await expect.poll(atBottom).toBe(true);
        await goTo(page, width, /^Files/);
        await expect(page.locator(".file-name").first()).toBeVisible();
        await expect.poll(async () => (await scroll(page)).top).toBe(0);
      });

      test(`screenshots ${scheme} ${String(width)}`, async ({ page }) => {
        await open(page, width, scheme);
        const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
        mkdirSync(directory, { recursive: true });
        for (const [label, name] of [
          [/^Questions/, "questions"],
          [/^Files/, "files"],
        ] as const) {
          await goTo(page, width, label);
          await page.waitForTimeout(150);
          await page.screenshot({
            path: join(directory, `${name}-${scheme}-${String(width)}.png`),
          });
        }
      });
    });
  }
}

// A new Questions filter is a new list: it lands at the top, like opening the page does.
for (const width of [390, 1280]) {
  test(`a new Questions filter lands at the top, ${String(width)} px @csp`, async ({ page }) => {
    await open(page, width, "light");
    await goTo(page, width, /^Questions/);
    await expect(page.locator(".question-text").first()).toBeVisible();
    // Scroll down the page, then choose a node of the tree.
    await page.locator(".conversation").evaluate((node) => {
      node.scrollTo({ top: 400, behavior: "instant" });
    });
    expect((await scroll(page)).top).toBeGreaterThan(100);
    if (width < 721) await page.getByRole("button", { name: en["nav.back"] }).click();
    await page.locator(".questions-tree button", { hasText: /^Open/ }).click();
    await expect.poll(async () => (await scroll(page)).top).toBe(0);
  });
}

// Landing at the top of a list page must not stop the chat that follows from following the
// newest messages: a short chat that later overflows stays at its bottom.
const opsId = (n: number) => `2026-11-04T10${String(n).padStart(2, "0")}-alice-agent-ops-01`;
const withOps = (count: number, revision: string) => {
  const base = JSON.parse(snapshot) as {
    files: { path: string; text: string }[];
    revision: string;
  };
  return JSON.stringify({
    ...base,
    revision,
    files: [
      ...base.files,
      ...Array.from({ length: count }, (_, n) => ({
        path: `inbox/2026-11/${opsId(n)}.md`,
        text: messageText(
          opsId(n),
          "alice-agent",
          "ops",
          { type: "info" },
          `Ops note ${String(n).padStart(2, "0")}.\n\nA second paragraph so each message takes some height.`,
        ),
      })),
    ],
  });
};

for (const width of [390, 1280]) {
  test(`a chat opened after a list page keeps following new messages, ${String(width)} px @csp`, async ({
    page,
  }) => {
    let body = withOps(1, "r1");
    await page.route("**/hosted-snapshot.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body }),
    );
    await page.clock.install();
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    await expect(page.locator(".topics")).toBeVisible();
    await goTo(page, width, /^Questions/);
    await expect(page.locator(".question-text").first()).toBeVisible();
    // A short chat: it fits the pane, so landing at its bottom moves nothing.
    await goTo(page, width, /^#ops/);
    await expect(page.locator(".message")).toHaveCount(1);
    expect((await scroll(page)).max).toBeLessThanOrEqual(0);
    // Messages arrive until the chat overflows the pane: its bottom stays in view.
    body = withOps(30, "r2");
    await page.clock.fastForward(60_000);
    await expect(page.locator(".message")).toHaveCount(30);
    await expect
      .poll(async () => {
        const state = await scroll(page);
        return state.max > 200 && state.max - state.top <= 2;
      })
      .toBe(true);
  });
}

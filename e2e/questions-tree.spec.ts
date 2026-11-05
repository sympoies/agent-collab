// The tree in the left list: views first, a Topics heading, and the Questions node with its
// open, per-person and answered filters. Synthetic data only. The "@csp" tag also runs these in
// the WebKit project (see playwright.config.ts).

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "../src/i18n/catalog";
import { messageText } from "../tests/support";

const Q_CAROL = "2026-11-04T0900-alice-agent-api-01"; // to bob and carol; bob answered
const A_BOB = "2026-11-04T0905-bob-agent-api-01";
const Q_BOB_DONE = "2026-11-04T0910-alice-agent-api-02";
const A_BOB_DONE = "2026-11-04T0915-bob-agent-api-02";
const Q_ALICE = "2026-11-04T0920-carol-agent-api-03";
const Q_BOB = "2026-11-04T0930-alice-agent-ops-01";
const file = (id: string, from: string, topic: string, fields: Record<string, string>) => ({
  path: `inbox/2026-11/${id}.md`,
  text: messageText(id, from, topic, fields, `Message ${id}.`),
});
const snapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:59:00.000Z",
  revision: "r1",
  files: [
    {
      path: ".agent-collab",
      text: "collab-protocol: 1\nparticipants: alice-agent, bob-agent, carol-agent\n",
    },
    file(Q_CAROL, "alice-agent", "api", { type: "question", to: "bob-agent, carol-agent" }),
    file(A_BOB, "bob-agent", "api", { type: "answer", to: "alice-agent", reply_to: Q_CAROL }),
    file(Q_BOB_DONE, "alice-agent", "api", { type: "question", to: "bob-agent" }),
    file(A_BOB_DONE, "bob-agent", "api", {
      type: "answer",
      to: "alice-agent",
      reply_to: Q_BOB_DONE,
    }),
    file(Q_ALICE, "carol-agent", "api", { type: "question", to: "alice-agent" }),
    file(Q_BOB, "alice-agent", "ops", { type: "question", to: "bob-agent" }),
  ],
});

async function open(page: Page, width: number, scheme: "light" | "dark", saved?: unknown) {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  if (saved !== undefined) {
    await page.addInitScript((value) => {
      // A reload keeps what the test seeded the first time only.
      if (localStorage.getItem("seeded") === null) {
        localStorage.setItem(`agent-collab-viewer.view:hosted:${location.origin}/`, value);
        localStorage.setItem("seeded", "1");
      }
    }, JSON.stringify(saved));
  }
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  await expect(page.locator(".topics")).toBeVisible();
}

const row = (page: Page) => page.locator(".topics > button", { hasText: /^Questions/ });
const child = (page: Page, text: RegExp) =>
  page.locator(".questions-tree button", { hasText: text });
const items = (page: Page) => page.locator(".question-item");

async function openQuestions(page: Page) {
  await row(page).click();
  await expect(items(page)).toHaveCount(4);
}

for (const scheme of ["light", "dark"] as const) {
  for (const width of [390, 768, 1280]) {
    test.describe(`the Questions tree, ${scheme} ${String(width)} px @csp`, () => {
      test("groups the views first and puts a Topics heading above the topics @csp", async ({
        page,
      }) => {
        await open(page, width, scheme);
        await expect(page.locator(".topics-pane > h2")).toHaveCount(0);
        const labels = await page
          .locator(".topics > *")
          .evaluateAll((nodes) =>
            nodes.map((node) => (node.tagName === "H2" ? "#heading" : node.textContent)),
          );
        const heading = labels.indexOf("#heading");
        expect(heading).toBe(3);
        expect(labels.slice(0, 3).map((text) => text.replace(/\d.*$/, "").trim())).toEqual([
          "All",
          "Questions",
          "Files",
        ]);
        await expect(page.locator(".topics .topics-heading")).toHaveText(en["nav.topics"]);
      });

      test("the Questions row opens every question and lists Open, people and Answered @csp", async ({
        page,
      }) => {
        await open(page, width, scheme);
        await openQuestions(page);
        await expect(row(page)).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator(".questions-tree button")).toHaveText([
          /^Open\s*3$/,
          /^alice-agent\s*1$/,
          /^bob-agent\s*1$/,
          /^carol-agent\s*1$/,
          /^Answered\s*1$/,
        ]);
      });

      test("each filter shows the right questions, names itself and clears @csp", async ({
        page,
      }) => {
        await open(page, width, scheme);
        await openQuestions(page);
        const filterBar = page.locator(".question-filter");
        const pick = async (text: RegExp) => {
          // On a phone the list is a screen of its own: back to it before each choice.
          if (width < 721 && !(await page.locator(".questions-tree").isVisible())) {
            await page.getByRole("button", { name: en["nav.back"] }).click();
          }
          await child(page, text).click();
        };
        await pick(/^Open/);
        await expect(items(page)).toHaveCount(3);
        await expect(filterBar).toContainText("open questions");
        await pick(/^carol-agent/);
        await expect(items(page)).toHaveCount(1);
        await expect(items(page).first()).toContainText(Q_CAROL);
        await expect(filterBar).toContainText("carol-agent");
        await pick(/^Answered/);
        await expect(items(page)).toHaveCount(1);
        await expect(items(page).first()).toContainText(Q_BOB_DONE);
        await filterBar.getByRole("button", { name: en["questions.filterClear"] }).click();
        await expect(items(page)).toHaveCount(4);
        await expect(filterBar).toHaveCount(0);
      });

      test("the filter and the expansion survive a reload @csp", async ({ page }) => {
        await open(page, width, scheme);
        await openQuestions(page);
        if (width < 721) await page.getByRole("button", { name: en["nav.back"] }).click();
        await child(page, /^carol-agent/).click();
        await expect(items(page)).toHaveCount(1);
        await page.reload();
        if (width < 721) {
          // A phone reopens the screen it was on; the list shows the node still expanded.
          await expect(items(page)).toHaveCount(1);
          await page.getByRole("button", { name: en["nav.back"] }).click();
        }
        await expect(row(page)).toHaveAttribute("aria-expanded", "true");
        await expect(child(page, /^carol-agent/)).toHaveAttribute("aria-pressed", "true");
        await expect(items(page)).toHaveCount(1);
      });

      test("a saved person who no longer owes an answer shows every question @csp", async ({
        page,
      }) => {
        await open(page, width, scheme, {
          view: "questions",
          topic: null,
          conversation: false,
          questions: { open: true, filter: { kind: "person", person: "ghost-agent" } },
        });
        if (width < 721) await row(page).click();
        await expect(items(page)).toHaveCount(4);
        await expect(page.locator(".question-filter")).toHaveCount(0);
        await expect(page.locator(".error")).toHaveCount(0);
      });

      test(`screenshots ${scheme} ${String(width)}`, async ({ page }) => {
        await open(page, width, scheme);
        await openQuestions(page);
        if (width < 721) await page.getByRole("button", { name: en["nav.back"] }).click();
        await child(page, /^carol-agent/).click();
        await expect(items(page)).toHaveCount(1);
        if (width < 721) await page.getByRole("button", { name: en["nav.back"] }).click();
        // The page opens at its latest content; show it from the top.
        await page.locator(".conversation").evaluate((node) => {
          node.scrollTo({ top: 0, behavior: "instant" });
        });
        const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
        mkdirSync(directory, { recursive: true });
        await page.screenshot({
          path: join(directory, `tree-${scheme}-${String(width)}.png`),
        });
      });
    });
  }
}

test("on a phone a node opens its page and the system back returns to the list @csp", async ({
  page,
}) => {
  await open(page, 390, "light");
  await row(page).click();
  await expect(items(page)).toHaveCount(4);
  await page.goBack();
  await expect(page.locator(".conversation")).toBeHidden();
  await expect(row(page)).toHaveAttribute("aria-expanded", "true");
  await child(page, /^bob-agent/).click();
  await expect(items(page)).toHaveCount(1);
  await page.goBack();
  await expect(page.locator(".conversation")).toBeHidden();
});

// A topic row is one frame (the row's own): the name is plain text, and on a phone the expanded
// tree and the Topics heading take full lines of the wrapping list instead of sharing one with
// the rows around them.
for (const scheme of ["light", "dark"] as const) {
  for (const width of [360, 390, 430, 1280]) {
    test(`the list has no nested frames and keeps its lines, ${scheme} ${String(width)} px @csp`, async ({
      page,
    }) => {
      await open(page, width, scheme);
      await row(page).click();
      await expect(items(page)).toHaveCount(4);
      if (width < 721) await page.getByRole("button", { name: en["nav.back"] }).click();
      await expect(page.locator(".questions-tree")).toBeVisible();
      const topicRows = page.locator(".topics button", { hasText: /^#/ });
      await expect(topicRows.first()).toBeVisible();
      await expect(page.locator(".topics button .shared-topic-chip")).toHaveCount(0);
      const frames = await topicRows.evaluateAll((nodes) =>
        nodes.map((node) => {
          const name = node.querySelector(".topic-name");
          return name === null ? -1 : parseFloat(getComputedStyle(name).borderTopWidth);
        }),
      );
      expect(frames.every((frame) => frame === 0)).toBe(true);
      // Lines of the list, top to bottom: Files, the Topics heading, the first topic row.
      const box = async (locator: Locator) => {
        const rect = await locator.boundingBox();
        expect(rect).not.toBeNull();
        return rect ?? { x: 0, y: 0, width: 0, height: 0 };
      };
      const files = await box(page.locator(".topics > button", { hasText: /^Files/ }));
      const heading = await box(page.locator(".topics .topics-heading"));
      const first = await box(topicRows.first());
      const tree = await box(page.locator(".questions-tree"));
      const nav = await box(page.locator(".topics"));
      expect(heading.y).toBeGreaterThanOrEqual(files.y + files.height - 1);
      expect(first.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1);
      expect(tree.width).toBeGreaterThanOrEqual(nav.width - 24);
    });
  }
}

// Screenshots for review at 360 px: the plain tree, and a Japanese list with long names.
const LONG_PERSON = "a-participant-with-a-name-that-is-long-enough-to-wrap-agent";
const LONG_TOPIC = "a-topic-name-that-is-long-enough-to-wrap-without-overflow-at-phone-width";
const LONG_ID = `2026-11-04T0940-alice-agent-${LONG_TOPIC}-01`;
const longSnapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:59:00.000Z",
  revision: "r1",
  files: [
    {
      path: ".agent-collab",
      text: `collab-protocol: 1\nparticipants: alice-agent, ${LONG_PERSON}\n`,
    },
    file(LONG_ID, "alice-agent", LONG_TOPIC, { type: "question", to: LONG_PERSON }),
    file(Q_BOB, "alice-agent", "ops", { type: "question", to: LONG_PERSON }),
  ],
});

for (const scheme of ["light", "dark"] as const) {
  test(`screenshots 360 ${scheme}`, async ({ page }) => {
    await open(page, 360, scheme);
    await openQuestions(page);
    await page.getByRole("button", { name: en["nav.back"] }).click();
    await child(page, /^carol-agent/).click();
    await page.getByRole("button", { name: en["nav.back"] }).click();
    const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `tree-${scheme}-360.png`) });
  });

  test(`screenshots long labels in Japanese 360 ${scheme}`, async ({ page }) => {
    await page.route("**/hosted-snapshot.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: longSnapshot }),
    );
    await page.addInitScript(() => {
      localStorage.setItem("agent-collab-viewer.locale", "ja");
    });
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 360, height: 844 });
    await page.goto("/");
    await page.locator(".topics > button").nth(1).click();
    await page.getByRole("button", { name: /^会話一覧に戻る$/ }).click();
    await expect(page.locator(".questions-tree")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `tree-long-ja-${scheme}-360.png`) });
  });
}

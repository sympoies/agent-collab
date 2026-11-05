// The tree in the left list: views first, a Topics heading, and the Questions node with its
// open, per-person and answered filters. Synthetic data only. The "@csp" tag also runs these in
// the WebKit project (see playwright.config.ts).

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

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
        localStorage.setItem("agent-collab-viewer.view:hosted:http://127.0.0.1:4173/", value);
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

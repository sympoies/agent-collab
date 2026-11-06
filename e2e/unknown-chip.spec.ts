// A question whose topic has older history that is not loaded yet shows its real state; only a
// message that is not older than the question could change it. Synthetic data only. The "@csp"
// tag also runs these in WebKit.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { en } from "../src/i18n/catalog";
import { messageText } from "../tests/support";

const HISTORY = 70; // older messages: more than the first page of 50 holds
const hist = (n: number) =>
  `2026-10-01T${String(Math.floor(n / 60)).padStart(2, "0")}${String(n % 60).padStart(2, "0")}-alice-agent-general-01`;
const OPEN_Q = "2026-11-04T0900-alice-agent-general-01";
const ANSWERED_Q = "2026-11-04T0910-alice-agent-general-01";
const ANSWER = "2026-11-04T0915-bob-agent-general-01";
const snapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:59:00.000Z",
  revision: "r1",
  files: [
    { path: ".agent-collab", text: "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n" },
    ...Array.from({ length: HISTORY }, (_, n) => ({
      path: `inbox/2026-10/${hist(n)}.md`,
      text: messageText(
        hist(n),
        "alice-agent",
        "general",
        { type: "info" },
        `History ${String(n)}.`,
      ),
    })),
    {
      path: `inbox/2026-11/${OPEN_Q}.md`,
      text: messageText(
        OPEN_Q,
        "alice-agent",
        "general",
        { type: "question", to: "bob-agent" },
        "The open question.",
      ),
    },
    {
      path: `inbox/2026-11/${ANSWERED_Q}.md`,
      text: messageText(
        ANSWERED_Q,
        "alice-agent",
        "general",
        { type: "question", to: "bob-agent" },
        "The answered question.",
      ),
    },
    {
      path: `inbox/2026-11/${ANSWER}.md`,
      text: messageText(
        ANSWER,
        "bob-agent",
        "general",
        { type: "answer", to: "alice-agent", reply_to: ANSWERED_Q },
        "The answer.",
      ),
    },
  ],
});

async function open(page: Page, width: number) {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/");
  await expect(page.locator(".topics")).toBeVisible();
}

const goTo = async (page: Page, width: number, label: RegExp) => {
  if (width < 721 && (await page.locator(".conversation").isVisible())) {
    await page.getByRole("button", { name: en["nav.back"] }).click();
  }
  await page.locator(".topics > button").filter({ hasText: label }).first().click();
};

for (const width of [390, 1280]) {
  test.describe(`Questions with more history than the first load, ${String(width)} px @csp`, () => {
    const expectKnown = async (page: Page) => {
      await expect(page.locator(".question-item")).toHaveCount(2);
      // The group of questions whose state cannot be derived yet must not appear.
      await expect(
        page.getByRole("region", { name: en["questions.unknown"], exact: true }),
      ).toHaveCount(0);
      const open = page.getByRole("region", { name: en["questions.open"], exact: true });
      await expect(open.locator(".question-item")).toHaveCount(1);
      await expect(open).toContainText("The open question.");
      await expect(open.locator(".shared-status-chip").first()).toHaveText(/^open$/i);
      const answered = page.getByRole("region", { name: en["questions.answered"], exact: true });
      await expect(answered).toContainText("The answered question.");
    };

    test("the newest questions show their real state, before and after loading older messages @csp", async ({
      page,
    }) => {
      await open(page, width);
      await goTo(page, width, /^Questions/);
      await expectKnown(page);
      // Load the older messages in the chat: nothing about the questions changes.
      await goTo(page, width, /^All/);
      await expect(page.locator(".message").first()).toBeVisible();
      // The receipts of the open question (from the same state) are not "unknown" either: the
      // question is open and its recipient has not answered.
      const receipts = page.locator(`#msg-${OPEN_Q} .receipts`);
      await expect(receipts.locator(".question-progress")).toHaveAttribute("data-state", "open");
      await expect(receipts.locator("li[data-state='waiting']")).toHaveCount(1);
      await page.getByRole("button", { name: en["nav.loadOlder"] }).first().click();
      await expect(page.getByText("History 0.")).toBeVisible();
      await goTo(page, width, /^Questions/);
      await expectKnown(page);
    });

    test(`screenshots ${String(width)}`, async ({ page }) => {
      await open(page, width);
      await goTo(page, width, /^Questions/);
      await expectKnown(page);
      const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
      mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: join(directory, `questions-${String(width)}.png`) });
    });
  });
}

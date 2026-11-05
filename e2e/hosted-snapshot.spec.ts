// A deployment that serves hosted-snapshot.json next to the app opens it without a token or a
// folder, and follows the file as it is replaced. Synthetic data only. The "@csp" tag also runs
// these in the WebKit project (see playwright.config.ts).

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { en, LOCALE_NAMES, LOCALES } from "../src/i18n/catalog";
import { ja } from "../src/i18n/ja";
import { zhTW } from "../src/i18n/zh-TW";
import { flat, MARKER, messageText } from "../tests/support";

const catalogsByLocale = { en, ja, "zh-TW": zhTW } as const;
const IDS = ["2026-10-01T0901-alice-agent-api-01", "2026-10-01T0902-alice-agent-api-01"];

function snapshot(revision: string, bodies: readonly string[], generatedAt: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt,
    revision,
    files: [
      { path: ".agent-collab", text: MARKER },
      ...bodies.map((body, n) => ({
        path: flat("2026-10", 1, n + 1),
        text: messageText(IDS[n] as string, "alice-agent", "api", {}, body),
      })),
    ],
  });
}

/** Serves `current()` as the snapshot and fails any request that leaves the deployment's host. */
async function deploy(page: Page, current: () => string | null): Promise<{ foreign: string[] }> {
  const foreign: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      foreign.push(route.request().url());
      await route.abort();
    } else if (url.pathname === "/hosted-snapshot.json") {
      const body = current();
      if (body === null) await route.fulfill({ status: 404, body: "" });
      else await route.fulfill({ status: 200, contentType: "application/json", body });
    } else {
      await route.continue();
    }
  });
  return { foreign };
}

test("a hosted snapshot opens by itself and follows the file @csp", async ({ page }) => {
  let body = snapshot("r1", ["First hosted message."], "2026-11-04T09:00:00.000Z");
  const { foreign } = await deploy(page, () => body);
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByText("First hosted message.")).toBeVisible();
  await expect(page.getByText(en["bar.hostedSnapshot"])).toBeVisible();
  await expect(page.locator(".last-changed")).toContainText("Snapshot updated");
  await expect(page.locator("h1")).toHaveCount(1);

  // The refresh interval picks up a replaced file.
  body = snapshot("r2", ["First hosted message.", "Second by timer."], "2026-11-04T09:01:00.000Z");
  await page.clock.fastForward(60_000);
  await expect(page.getByText("Second by timer.")).toBeVisible();

  // So does the refresh button, before any timer.
  body = snapshot("r3", ["First hosted message.", "Third by button."], "2026-11-04T09:02:00.000Z");
  await page.getByRole("button", { name: en["bar.refresh"], exact: true }).click();
  await expect(page.getByText("Third by button.")).toBeVisible();
  expect(foreign).toEqual([]);
});

test("a deployment without the file shows the normal welcome screen @csp", async ({ page }) => {
  await deploy(page, () => null);
  await page.goto("/");
  await expect(page.getByRole("button", { name: en["welcome.openLiveDemo"] })).toBeVisible();
  await expect(page.getByRole("button", { name: en["welcome.openHosted"] })).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCount(1);
});

for (const code of LOCALES) {
  test(`the hosted snapshot fits a 390px screen in ${LOCALE_NAMES[code]} @csp`, async ({
    page,
  }) => {
    const messages = catalogsByLocale[code];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((locale) => {
      localStorage.setItem("agent-collab-viewer.locale", locale);
    }, code);
    await deploy(page, () => snapshot("r1", ["Hosted message."], "2026-11-04T09:00:00.000Z"));
    await page.goto("/");
    await expect(page.getByText(messages["bar.hostedSnapshot"])).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
  });
}

for (const code of LOCALES) {
  test(`the welcome screen of an unreadable snapshot fits 390px in ${LOCALE_NAMES[code]} @csp`, async ({
    page,
  }) => {
    const messages = catalogsByLocale[code];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((locale) => {
      localStorage.setItem("agent-collab-viewer.locale", locale);
    }, code);
    // The page's probe finds the file; every later fetch (the one that opens it) does not.
    let served = 0;
    await deploy(page, () => {
      served += 1;
      return served === 1 ? snapshot("r1", ["Hosted message."], "2026-11-04T09:00:00.000Z") : null;
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: messages["welcome.openHosted"] })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(messages["hosted.unreadable"]);
    await expect(page.locator("h1")).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
  });
}

// A snapshot in the topic layout: a message added to a month folder that is already listed must
// appear without a reload, by the timer and by the refresh button.
test("a hosted snapshot of topic folders shows new messages in an existing month @csp", async ({
  page,
}) => {
  const topicId = (n: number) => `2026-11-04T090${String(n)}-alice-agent-general-01`;
  const topicSnapshot = (revision: string, bodies: readonly string[], generatedAt: string) =>
    JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      revision,
      files: [
        {
          path: ".agent-collab",
          text: "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent\n",
        },
        ...bodies.map((body, n) => ({
          path: `topics/general/inbox/2026-11/${topicId(n + 1)}.md`,
          text: messageText(topicId(n + 1), "alice-agent", "general", {}, body),
        })),
      ],
    });
  let body = topicSnapshot("r1", ["First topic message."], "2026-11-04T09:00:00.000Z");
  const { foreign } = await deploy(page, () => body);
  await page.clock.install();
  await page.goto("/");
  // The topic list comes first; the topic's messages load when it is opened.
  await page.getByRole("button", { name: "#general", exact: true }).click();
  await expect(page.getByText("First topic message.")).toBeVisible();

  body = topicSnapshot(
    "r2",
    ["First topic message.", "Second by timer."],
    "2026-11-04T09:01:00.000Z",
  );
  await page.clock.fastForward(60_000);
  await expect(page.getByText("Second by timer.")).toBeVisible();

  body = topicSnapshot(
    "r3",
    ["First topic message.", "Second by timer.", "Third by button."],
    "2026-11-04T09:02:00.000Z",
  );
  await page.getByRole("button", { name: en["bar.refresh"], exact: true }).click();
  await expect(page.getByText("Third by button.")).toBeVisible();
  expect(foreign).toEqual([]);
});

// The All view is the whole conversation across topics, also straight after a reload and on a
// phone; screenshots: PLAYWRIGHT_SCREENSHOT_DIR=<dir> pnpm exec playwright test e2e/hosted-snapshot.spec.ts -g "All view"
test("the All view shows every topic after a reload and on a phone @csp", async ({ page }) => {
  const ids = ["2026-11-04T0901-alice-agent-api-01", "2026-11-04T0902-alice-agent-ops-01"];
  const topics = ["api", "ops"];
  const body = JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-11-04T09:00:00.000Z",
    revision: "r1",
    files: [
      {
        path: ".agent-collab",
        text: "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent\n",
      },
      ...ids.map((id, n) => ({
        path: `topics/${topics[n] as string}/inbox/2026-11/${id}.md`,
        text: messageText(
          id,
          "alice-agent",
          topics[n] as string,
          {},
          `Message in ${topics[n] as string}.`,
        ),
      })),
    ],
  });
  const { foreign } = await deploy(page, () => body);
  await page.goto("/");
  await expect(page.getByText("Message in api.")).toBeVisible();
  await expect(page.getByText("Message in ops.")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Message in api.")).toBeVisible();
  await expect(page.getByText("Message in ops.")).toBeVisible();
  await expect(page.getByText(en["chat.empty"])).toHaveCount(0);
  const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, "all-view-after-reload.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: en["nav.all"], exact: true }).click();
  await expect(page.getByText("Message in api.")).toBeVisible();
  await expect(page.getByText("Message in ops.")).toBeVisible();
  await page.screenshot({ path: join(directory, "all-view-after-reload-phone.png") });
  expect(foreign).toEqual([]);
});

// The hosted snapshot is a real repository's data: who the reader views as and the topic they had
// open come back after a reload, as language and theme do.
test("a hosted snapshot keeps Viewing as and the selected topic across a reload @csp", async ({
  page,
}) => {
  // A topic long enough to scroll: 59 older messages and the one the test looks for last.
  const opsIds = Array.from(
    { length: 60 },
    (_, n) =>
      `2026-11-04T${String(Math.floor(n / 60) + 10).padStart(2, "0")}${String(n % 60).padStart(2, "0")}-bob-agent-ops-01`,
  );
  const apiId = "2026-11-04T0901-alice-agent-api-01";
  const body = JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-11-04T09:00:00.000Z",
    revision: "r1",
    files: [
      {
        path: ".agent-collab",
        text: "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n",
      },
      {
        path: `topics/api/inbox/2026-11/${apiId}.md`,
        text: messageText(apiId, "alice-agent", "api", {}, "Message in api."),
      },
      ...opsIds.map((id, n) => ({
        path: `topics/ops/inbox/2026-11/${id}.md`,
        text: messageText(
          id,
          "bob-agent",
          "ops",
          {},
          n === opsIds.length - 1 ? "Message in ops." : `Older ops message ${String(n)}.`,
        ),
      })),
    ],
  });
  const { foreign } = await deploy(page, () => body);
  await page.goto("/");
  await page.getByRole("button", { name: "#ops", exact: true }).click();
  await expect(page.getByText("Message in ops.")).toBeVisible();
  await page.locator(".bar-actions .identity-button").click();
  await page
    .getByRole("region", { name: en["profile.title"] })
    .getByLabel(en["bar.viewingAs"])
    .selectOption("bob-agent");
  await page.keyboard.press("Escape");
  // Scrolled to the top before the reload, the restored topic still opens at its latest message.
  const pane = page.getByRole("main");
  await pane.evaluate((node) => {
    node.scrollTop = 0;
  });

  await page.reload();
  await page.locator(".bar-actions .identity-button").click();
  await expect(
    page.getByRole("region", { name: en["profile.title"] }).getByLabel(en["bar.viewingAs"]),
  ).toHaveValue("bob-agent");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "#ops", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("Message in ops.")).toBeVisible();
  await expect(page.getByText("Message in api.")).toHaveCount(0);
  await expect
    .poll(() => pane.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThanOrEqual(1);
  expect(await pane.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(500);

  // The Files view comes back too, and the choices stay in this browser only.
  await page.getByRole("button", { name: en["nav.files"], exact: true }).click();
  await page.reload();
  await expect(page.locator("#conversation-heading")).toHaveText("Files");
  await expect(page.getByRole("button", { name: en["files.allTopics"] })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(foreign).toEqual([]);
});

for (const width of [360, 390, 430]) {
  test(`Viewing as lists the hosted roster before opening a topic at ${String(width)}px @csp`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const id = "2026-11-04T0901-alice-agent-api-01";
    const body = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-11-04T09:00:00.000Z",
      revision: "r1",
      files: [
        {
          path: ".agent-collab",
          text: "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n",
        },
        {
          path: `topics/api/inbox/2026-11/${id}.md`,
          text: messageText(id, "alice-agent", "api", {}, "Topic message stays unopened."),
        },
      ],
    });
    await deploy(page, () => body);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "#api", exact: true })).toBeVisible();
    await expect(page.getByText("Topic message stays unopened.")).toHaveCount(0);

    const identity = page.locator(".bar-actions .identity-button");
    await identity.click();
    const panel = page.getByRole("region", { name: en["profile.title"] });
    const viewingAs = panel.getByLabel(en["bar.viewingAs"]);
    await expect(viewingAs.locator("option")).toHaveText([
      en["bar.observer"],
      "alice-agent",
      "bob-agent",
    ]);
    const screenshotDirectory = process.env.ROSTER_SCREENSHOT_DIR;
    if (width === 390 && browserName === "chromium" && screenshotDirectory !== undefined) {
      mkdirSync(screenshotDirectory, { recursive: true });
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({
          path: join(screenshotDirectory, `viewing-as-roster-${scheme}-390.png`),
        });
      }
      await page.emulateMedia({ colorScheme: "light" });
    }
    await viewingAs.selectOption("bob-agent");
    await page.keyboard.press("Escape");
    await expect(identity).toHaveAttribute(
      "aria-label",
      en["identity.button"].replace("{name}", "bob-agent"),
    );

    await page.reload();
    await identity.click();
    await expect(panel.getByLabel(en["bar.viewingAs"])).toHaveValue("bob-agent");
    await expect(page.getByRole("button", { name: "#api", exact: true })).toBeVisible();
  });
}

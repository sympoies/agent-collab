// The topic list of a repository in the topic layout, in every language and theme, on a desktop
// and on a phone. Synthetic data only: a stubbed GitHub API, no real network. The "@csp" tag also
// runs the tests in WebKit.

import { expect, test, type Route } from "@playwright/test";

const LONG_TOPIC = "a-topic-name-that-is-long-enough-to-wrap-without-overflow-at-phone-width";
const FILLERS = Array.from(
  { length: 12 },
  (_, index) => `topic-${String(index + 1).padStart(2, "0")}`,
);
const MESSAGE_ID = "2026-10-01T0900-alice-agent-api-01";
const MARKER = "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent\n";

const TEXT = {
  en: {
    closed: "Closed (1)",
    back: "Back to conversations",
    showAll: "Show all 14 topics",
    showFewer: "Show fewer",
    entries: ["All", "Questions", "Files"],
    language: "English",
  },
  ja: {
    closed: "閉じたトピック（1）",
    back: "会話一覧に戻る",
    showAll: "14 件のトピックをすべて表示",
    showFewer: "表示を減らす",
    entries: ["すべて", "質問", "ファイル"],
    language: "日本語",
  },
  "zh-TW": {
    closed: "已關閉的主題（1）",
    back: "返回對話列表",
    showAll: "顯示全部 14 個主題",
    showFewer: "顯示較少",
    entries: ["全部", "問題", "檔案"],
    language: "繁體中文",
  },
} as const;

const entry = (path: string, sha: string, type: "blob" | "tree") => ({
  path,
  sha,
  type,
  mode: type === "tree" ? "040000" : "100644",
});

async function json(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

test.describe("topic list navigation", () => {
  for (const locale of ["en", "ja", "zh-TW"] as const) {
    for (const theme of ["paper", "night-owl"] as const) {
      for (const width of [1280, 390] as const) {
        test(`${locale}, ${theme}, ${String(width)}px @csp`, async ({ page }) => {
          const text = TEXT[locale];
          const requests: string[] = [];
          await page.addInitScript(
            ({ theme: selectedTheme }) => {
              localStorage.setItem("agent-collab-viewer.theme", selectedTheme);
            },
            { theme },
          );
          await page.setViewportSize({ width, height: width === 1280 ? 600 : 850 });
          await page.route("https://api.github.com/**", async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname.replace(
              "/repos/alice-agent/fixture-repo",
              "",
            );
            requests.push(path);
            if (request.headers()["authorization"] !== "Bearer fake-token") {
              await route.fulfill({ status: 401, body: "{}" });
              return;
            }
            if (path === "/git/ref/heads/main") {
              await json(route, { object: { sha: "rev" } });
            } else if (path === "/git/commits/rev") {
              await json(route, { tree: { sha: "root" } });
            } else if (path === "/git/trees/root") {
              await json(route, {
                truncated: false,
                tree: [
                  entry(".agent-collab", "marker", "blob"),
                  entry("index.md", "index", "blob"),
                  entry("topics", "topics", "tree"),
                ],
              });
            } else if (path === "/git/trees/topics") {
              await json(route, {
                truncated: false,
                tree: [
                  entry("api", "topic:api", "tree"),
                  entry(LONG_TOPIC, "topic:long", "tree"),
                  entry("archive", "topic:archive", "tree"),
                  ...FILLERS.map((name) => entry(name, `topic:${name}`, "tree")),
                ],
              });
            } else if (path === "/git/trees/topic:api") {
              await json(route, { truncated: false, tree: [entry("inbox", "inbox:api", "tree")] });
            } else if (path === "/git/trees/topic:archive") {
              await json(route, {
                truncated: false,
                tree: [entry("inbox", "inbox:archive", "tree")],
              });
            } else if (path === "/git/trees/inbox:archive") {
              await json(route, {
                truncated: false,
                tree: [entry("2026-01", "month:archive", "tree")],
              });
            } else if (path === "/git/trees/month:archive") {
              await json(route, { truncated: false, tree: [] });
            } else if (path === "/git/trees/inbox:api") {
              await json(route, {
                truncated: false,
                tree: [entry("2026-10", "month:api", "tree")],
              });
            } else if (path === "/git/trees/month:api") {
              await json(route, {
                truncated: false,
                tree: [entry(`${MESSAGE_ID}.md`, "message:api", "blob")],
              });
            } else if (
              path === "/git/trees/topic:long" ||
              FILLERS.some((name) => path === `/git/trees/topic:${name}`)
            ) {
              await json(route, { truncated: false, tree: [] });
            } else if (path === "/git/blobs/marker") {
              await route.fulfill({ status: 200, body: MARKER });
            } else if (path === "/git/blobs/index") {
              await route.fulfill({
                status: 200,
                body: [
                  "| topic | title | status |",
                  "|---|---|---|",
                  "| api | The API | open |",
                  `| ${LONG_TOPIC} | | open |`,
                  "| archive | Archive | closed |",
                  ...FILLERS.map((name) => `| ${name} | | open |`),
                ].join("\n"),
              });
            } else if (path === "/git/blobs/message:api") {
              await route.fulfill({
                status: 200,
                body: [
                  "---",
                  `id: ${MESSAGE_ID}`,
                  "from: alice-agent",
                  "to: bob-agent",
                  "topic: api",
                  "type: info",
                  "needs: none",
                  "---",
                  "Topic list message body.",
                ].join("\n"),
              });
            } else {
              await route.fulfill({ status: 404, body: "{}" });
            }
          });

          await page.goto("/");
          await page.getByRole("button", { name: "Open another repository" }).click();
          await page
            .getByRole("textbox", { name: "Repository", exact: true })
            .fill("alice-agent/fixture-repo");
          await page.getByLabel("Branch").fill("main");
          await page.getByLabel("My names").fill("alice-agent");
          await page.getByLabel("Access token").fill("fake-token");
          await page.getByRole("button", { name: "Save and open" }).click();
          if (width === 390) {
            await page.getByRole("button", { name: "More" }).click();
            await page.getByRole("menuitemradio", { name: text.language }).click();
          } else {
            await page.locator(".bar-actions .language-switcher select").selectOption(locale);
          }

          const list = page.locator(".topics-pane");
          const rows = list.locator(".topics > button");
          await expect(page.locator(".closed-topics summary")).toHaveText(text.closed);
          await expect(page.locator("h1")).toHaveCount(1);
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

          // All, Questions and Files come first, then the topics, most recently active first.
          for (const [index, label] of text.entries.entries()) {
            await expect(rows.nth(index)).toContainText(label);
          }
          // The list does not reorder under the pointer: keep it out of the list.
          await page.mouse.move(width - 20, 300);
          // Activity arrives after the list: the topic with a message moves up.
          await expect(rows.nth(3)).toHaveText("The API");
          await expect(rows.nth(4)).toHaveText(LONG_TOPIC);
          if (width === 390) {
            await expect(page.locator(".conversation")).toBeHidden();
          } else {
            await expect(page.locator(".conversation")).toBeVisible();
          }
          expect(requests.some((path) => path.startsWith("/git/blobs/message:"))).toBe(false);
          // A closed topic is read only once its group is opened.
          expect(requests).not.toContain("/git/trees/topic:archive");

          // Only the twelve most recent topics show; the button discloses the rest in place.
          const showAll = list.getByRole("button", { name: text.showAll });
          await expect(showAll).toHaveAttribute("aria-expanded", "false");
          await expect(list.getByRole("button", { name: "topic-12", exact: true })).toHaveCount(0);
          await showAll.focus();
          await page.keyboard.press("Enter");
          const showFewer = list.getByRole("button", { name: text.showFewer });
          await expect(showFewer).toHaveAttribute("aria-expanded", "true");
          await expect(showFewer).toBeFocused();
          await expect(list.getByRole("button", { name: "topic-12", exact: true })).toBeVisible();
          if (width === 1280) {
            // A long list scrolls inside the pane, never moving the page.
            const scrolls = await list.evaluate((pane) => ({
              inside: pane.scrollHeight > pane.clientHeight,
              style: getComputedStyle(pane).overflowY,
            }));
            expect(scrolls).toEqual({ inside: true, style: "auto" });
            const pageTop = await page.evaluate(() => window.scrollY);
            await list.evaluate((pane) => {
              pane.scrollTop = pane.scrollHeight;
            });
            expect(await page.evaluate(() => window.scrollY)).toBe(pageTop);
          }

          // The selected topic stays listed when the list is collapsed again.
          const hidden = list.getByRole("button", { name: "topic-12", exact: true });
          await hidden.click();
          if (width === 390) await page.getByRole("button", { name: text.back }).click();
          await showFewer.click();
          await expect(list.getByRole("button", { name: text.showAll })).toBeVisible();
          await expect(hidden).toBeVisible();
          await expect(list.getByRole("button", { name: "topic-11", exact: true })).toHaveCount(0);
          await expect(hidden).toHaveAttribute("aria-pressed", "true");

          // Opening the closed group reads that topic's activity, never its messages.
          const closedGroup = page.locator(".closed-topics summary");
          await closedGroup.focus();
          await page.keyboard.press("Enter");
          const archive = list.getByRole("button", { name: "Archive", exact: true });
          await expect(archive).toBeVisible();
          await expect.poll(() => requests.includes("/git/trees/month:archive")).toBe(true);
          expect(requests.some((path) => path === "/git/blobs/message:archive")).toBe(false);
          await page.keyboard.press("Enter");

          // A long name wraps inside its row: nothing is clipped or pushes the page sideways.
          const longTopic = list.getByRole("button", { name: LONG_TOPIC, exact: true });
          const heights = await Promise.all([rows.first().boundingBox(), longTopic.boundingBox()]);
          expect(heights[1]?.height ?? 0).toBeGreaterThan(heights[0]?.height ?? 0);
          expect(
            await longTopic.evaluate((button) => button.scrollWidth <= button.clientWidth),
          ).toBe(true);
          await longTopic.focus();
          await page.keyboard.press("Enter");
          await expect(page.getByRole("heading", { name: LONG_TOPIC, exact: true })).toBeVisible();
          if (width === 390) {
            await page.getByRole("button", { name: text.back }).click();
            await expect(longTopic).toBeFocused();
            await expect(page.locator(".conversation")).toBeHidden();
          }

          await page.getByRole("button", { name: "The API", exact: true }).click();
          await expect(page.getByText("Topic list message body.")).toBeVisible();
          expect(requests.filter((path) => path.startsWith("/git/blobs/message:"))).toEqual([
            "/git/blobs/message:api",
          ]);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
        });
      }
    }
  }
});

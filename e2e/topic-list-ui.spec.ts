import { expect, test, type Route } from "@playwright/test";

const LONG_TOPIC = "a-topic-name-that-is-long-enough-to-wrap-without-overflow-at-phone-width";
const MESSAGE_ID = "2026-10-01T0900-alice-agent-api-01";
const MARKER = "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent\n";
const CLOSED = {
  en: "Closed (1)",
  ja: "閉じたトピック（1）",
  "zh-TW": "已關閉的主題（1）",
} as const;
const BACK = {
  en: "Back to conversations",
  ja: "会話一覧に戻る",
  "zh-TW": "返回對話列表",
} as const;
const LOCALE_NAME = {
  en: "English",
  ja: "日本語",
  "zh-TW": "繁體中文",
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

test.describe("@topic-list topic list navigation", () => {
  for (const locale of ["en", "ja", "zh-TW"] as const) {
    for (const theme of ["paper", "night-owl"] as const) {
      for (const width of [1280, 390] as const) {
        test(`${locale}, ${theme}, ${width}px`, async ({ page }) => {
          const requests: string[] = [];
          await page.addInitScript(
            ({ theme: selectedTheme }) => {
              localStorage.setItem("agent-collab-viewer.theme", selectedTheme);
            },
            { theme },
          );
          await page.setViewportSize({ width, height: 850 });
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
                ],
              });
            } else if (path === "/git/trees/topic:api") {
              await json(route, { truncated: false, tree: [entry("inbox", "inbox:api", "tree")] });
            } else if (path === "/git/trees/topic:long") {
              await json(route, { truncated: false, tree: [] });
            } else if (path === "/git/trees/topic:archive") {
              await json(route, {
                truncated: false,
                tree: [entry("inbox", "inbox:archive", "tree")],
              });
            } else if (path === "/git/trees/inbox:archive") {
              await json(route, {
                truncated: false,
                tree: [entry("2026-10", "month:archive", "tree")],
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
            await page.getByRole("menuitemradio", { name: LOCALE_NAME[locale] }).click();
          } else {
            await page.locator(".bar-actions .language-switcher select").selectOption(locale);
          }

          await expect(page.locator(".topics-pane h2")).not.toBeEmpty();
          await expect(page.locator(".closed-topics summary")).toHaveText(CLOSED[locale]);
          await expect(page.locator("h1")).toHaveCount(1);
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

          const list = page.locator(".topics-pane");
          await expect(list.getByRole("button", { name: LONG_TOPIC, exact: true })).toBeVisible();
          if (width === 390) {
            await expect(page.locator(".conversation")).toBeHidden();
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth),
            ).toBeLessThanOrEqual(390);
          } else {
            await expect(page.locator(".conversation")).toBeVisible();
          }
          expect(requests.some((path) => path.startsWith("/git/blobs/message:"))).toBe(false);
          expect(requests.some((path) => path === "/git/trees/topic:archive")).toBe(false);

          const closedGroup = page.locator(".closed-topics summary");
          await closedGroup.focus();
          await page.keyboard.press("Enter");
          const archive = list.getByRole("button", { name: "Archive", exact: true });
          await expect(archive).toBeVisible();
          await archive.scrollIntoViewIfNeeded();
          await expect.poll(() => requests.includes("/git/trees/month:archive")).toBe(true);
          expect(requests).toContain("/git/trees/topic:archive");
          expect(requests).toContain("/git/trees/inbox:archive");
          expect(requests.some((path) => path === "/git/blobs/message:archive")).toBe(false);
          await page.keyboard.press("Enter");

          const longTopic = list.getByRole("button", { name: LONG_TOPIC, exact: true });
          await longTopic.focus();
          await page.keyboard.press("Enter");
          await expect(page.getByRole("heading", { name: LONG_TOPIC, exact: true })).toBeVisible();
          if (width === 390) {
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth),
            ).toBeLessThanOrEqual(390);
            await page.getByRole("button", { name: BACK[locale] }).click();
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

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

const screenshotDir = resolve(process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "");

interface MessageFixture {
  readonly id: string;
  readonly text: string;
}

function makeMessage(
  date: string,
  time: string,
  from: string,
  topic: string,
  sequence: number,
  type: string,
  body: string,
  to = "bob-agent",
  replyTo = "",
): MessageFixture {
  const id = `${date}T${time}-${from}-${topic}-${String(sequence).padStart(2, "0")}`;
  return {
    id,
    text: [
      "---",
      `id: ${id}`,
      `from: ${from}`,
      `to: ${to}`,
      `topic: ${topic}`,
      `type: ${type}`,
      `reply_to: ${replyTo}`,
      "refs:",
      "needs: none",
      "due:",
      "---",
      body,
    ].join("\n"),
  };
}

function longThread(): MessageFixture[] {
  const parent = makeMessage(
    "2026-10-08",
    "0900",
    "alice-agent",
    "api",
    1,
    "question",
    "A synthetic question starts this long thread.",
  );
  const grouped = makeMessage(
    "2026-10-08",
    "0901",
    "alice-agent",
    "api",
    2,
    "info",
    "A consecutive message from the same sender.",
    "all",
  );
  const reply = makeMessage(
    "2026-10-08",
    "0902",
    "bob-agent",
    "api",
    3,
    "answer",
    "A synthetic reply with a quoted parent.",
    "alice-agent",
    parent.id,
  );
  const ack = makeMessage(
    "2026-10-08",
    "0903",
    "bob-agent",
    "api",
    4,
    "ack",
    "A grouped acknowledgement.",
    "alice-agent",
    parent.id,
  );
  const locked = makeMessage(
    "2026-10-08",
    "0904",
    "alice-agent",
    "api",
    5,
    "info",
    "-----BEGIN AGE ENCRYPTED FILE-----\nsynthetic ciphertext\n-----END AGE ENCRYPTED FILE-----",
  );
  const result = [parent, grouped, reply, ack, locked];
  for (let index = 0; index < 24; index += 1) {
    const day = index < 12 ? "2026-10-08" : "2026-10-09";
    const dayIndex = index % 12;
    const minutes = 10 + dayIndex * 2;
    const time = `${String(9 + Math.floor(minutes / 60)).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}`;
    const from = Math.floor(index / 2) % 2 === 0 ? "alice-agent" : "bob-agent";
    result.push(
      makeMessage(
        day,
        time,
        from,
        "api",
        index + 6,
        index % 7 === 0 ? "decision-needed" : "info",
        `Synthetic thread message ${String(index + 1).padStart(2, "0")}.`,
        from === "alice-agent" ? "bob-agent" : "alice-agent",
      ),
    );
  }
  result.push(
    makeMessage(
      "2026-10-09",
      "1000",
      "alice-agent",
      "release",
      1,
      "info",
      "A separate topic for the conversation list.",
    ),
  );
  return result;
}

function treeEntry(path: string, sha: string, type: "blob" | "tree") {
  return { path, sha, type, mode: type === "tree" ? "040000" : "100644" };
}

function json(route: Route, value: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(value),
  });
}

async function installApiStub(page: Page, mode: "long" | "empty" | "error") {
  const messages = mode === "long" ? longThread() : [];
  const blobs = new Map<string, string>([["marker", "collab-protocol: 1\n"]]);
  const unhandled: string[] = [];
  let headCalls = 0;

  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== "GET" || request.headers()["authorization"] !== "Bearer fake-token") {
      unhandled.push(`${request.method()} ${path}`);
      await json(route, { message: "Unexpected fixture request" }, 500);
      return;
    }

    if (path.endsWith("/git/ref/heads/main")) {
      headCalls += 1;
      if (mode === "error") {
        await json(route, { message: "Synthetic provider error" }, 500);
      } else {
        await json(route, { object: { sha: headCalls > 1 ? "revision-2" : "revision-1" } }, 200, {
          etag: headCalls > 1 ? '"revision-2"' : '"revision-1"',
        });
      }
      return;
    }

    if (path.endsWith("/git/commits/revision-1") || path.endsWith("/git/commits/revision-2")) {
      const version = path.endsWith("revision-2") ? "2" : "1";
      await json(route, { tree: { sha: `root-${version}` } });
      return;
    }

    if (path.endsWith("/git/trees/root-1") || path.endsWith("/git/trees/root-2")) {
      const version = path.endsWith("root-2") ? "2" : "1";
      await json(route, {
        truncated: false,
        tree: [
          treeEntry(".agent-collab", "marker", "blob"),
          treeEntry("inbox", `inbox-${version}`, "tree"),
        ],
      });
      return;
    }

    if (path.endsWith("/git/trees/inbox-1") || path.endsWith("/git/trees/inbox-2")) {
      const version = path.endsWith("inbox-2") ? "2" : "1";
      const fixtureMessages =
        version === "2" && mode === "long"
          ? [
              ...messages,
              makeMessage(
                "2026-10-09",
                "1030",
                "bob-agent",
                "api",
                99,
                "info",
                "A new synthetic message arrives after refresh.",
                "all",
              ),
            ]
          : messages;
      const entries = fixtureMessages.map((message, index) => {
        const sha = `message-${version}-${String(index + 1)}`;
        blobs.set(sha, message.text);
        return treeEntry(`${message.id}.md`, sha, "blob");
      });
      await json(route, { truncated: false, tree: entries });
      return;
    }

    const blob = /\/git\/blobs\/([^/]+)$/.exec(path)?.[1];
    if (blob !== undefined && blobs.has(blob)) {
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: blobs.get(blob) ?? "",
      });
      return;
    }

    unhandled.push(`GET ${path}`);
    await json(route, { message: "Unexpected fixture request" }, 500);
  };

  await page.route("https://api.github.com/**", handle);
  return () => {
    expect(unhandled, "the app must make only fixture-backed API requests").toEqual([]);
  };
}

async function openViewer(page: Page, mode: "long" | "empty" | "error") {
  const assertRequests = await installApiStub(page, mode);
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Repository", exact: true })
    .fill("alice-agent/fixture-repo");
  await page.getByLabel("Branch").fill("main");
  await page.getByLabel("My names").fill("alice-agent");
  await page.getByLabel("Access token").fill("fake-token");
  await page.getByRole("button", { name: "Save and open" }).click();
  return assertRequests;
}

async function saveScreenshot(page: Page, filename: string) {
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, filename), fullPage: true });
}

test("long chat adapts across themes and viewports", async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const assertRequests = await openViewer(page, "long");
  await expect(page.locator(".bubble")).toHaveCount(30);
  await expect(page.locator(".day")).toHaveCount(2);
  await expect(page.locator(".group").first().locator(".bubble")).toHaveCount(2);
  await expect(page.locator(".quote").first()).toContainText(
    "A synthetic question starts this long thread.",
  );
  await expect(page.locator('[data-body="locked"]')).toContainText("cannot decrypt it yet");
  await expect(page.locator(".to").filter({ hasText: "everyone" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "#release" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Jump to latest" })).toHaveAttribute(
    "href",
    "#latest-message",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night-owl");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#011627");
  await saveScreenshot(page, "desktop-night-owl.png");

  await page.getByRole("button", { name: "Use Paper theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f4f3ed");
  await expect(
    page.evaluate(() => localStorage.getItem("agent-collab-viewer.theme")),
  ).resolves.toBe("paper");
  await saveScreenshot(page, "desktop-paper.png");

  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("separator", { name: "New messages" })).toBeVisible();
  await expect(page.getByText("A new synthetic message arrives after refresh.")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const columns = await page
    .locator(".workspace")
    .evaluate((node) => getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).length);
  expect(columns).toBe(1);
  const sidebar = await page.locator(".topics-pane").boundingBox();
  const conversation = await page.locator(".conversation").boundingBox();
  expect(sidebar).not.toBeNull();
  expect(conversation).not.toBeNull();
  expect(Math.abs((sidebar?.x ?? 0) - (conversation?.x ?? 0))).toBeLessThan(1);
  await saveScreenshot(page, "phone-paper.png");

  await page.getByRole("button", { name: "Use Night Owl theme" }).click();
  await saveScreenshot(page, "phone-night-owl.png");
  await page.getByRole("button", { name: "Use Paper theme" }).click();

  const reopened = await context.newPage();
  const assertReopenedRequests = await openViewer(reopened, "long");
  await expect(reopened.locator("html")).toHaveAttribute("data-theme", "paper");
  assertRequests();
  assertReopenedRequests();
});

test("empty repositories and provider errors have clear states", async ({ page }) => {
  const assertEmptyRequests = await openViewer(page, "empty");
  await expect(page.getByText("No messages yet.")).toBeVisible();
  assertEmptyRequests();

  const failedPage = await page.context().newPage();
  const assertErrorRequests = await openViewer(failedPage, "error");
  await expect(failedPage.getByRole("alert")).toContainText("unexpected (HTTP 500)");
  await saveScreenshot(failedPage, "error-state.png");
  assertErrorRequests();
});

test("keyboard focus, topic filtering, reduced motion, and unavailable storage work", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const assertRequests = await openViewer(page, "long");
  await expect(page.locator(".bubble").first()).toBeVisible();

  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => ({
    label: document.activeElement?.getAttribute("aria-label"),
    outlineStyle: getComputedStyle(document.activeElement as Element).outlineStyle,
    outlineWidth: getComputedStyle(document.activeElement as Element).outlineWidth,
  }));
  expect(focused.label).toBe("Use Paper theme");
  expect(focused.outlineStyle).toBe("solid");
  expect(focused.outlineWidth).toBe("3px");

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "#release" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveCSS("scroll-behavior", "auto");
  const timestamp = page.locator("time").first();
  await timestamp.focus();
  await expect(timestamp.locator(".time-tooltip")).toBeVisible();
  await expect(timestamp.locator(".time-tooltip")).toHaveText("2026-10-09 10:00");
  assertRequests();

  const preferencePage = await page.context().newPage();
  await preferencePage.addInitScript(() => {
    localStorage.setItem("agent-collab-viewer.theme", "paper");
  });
  await preferencePage.emulateMedia({ colorScheme: "dark" });
  await preferencePage.goto("/");
  await expect(preferencePage.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(preferencePage.getByRole("button", { name: "Use Night Owl theme" })).toBeVisible();
  await preferencePage.getByRole("button", { name: "Open demo repository" }).click();
  await expect(preferencePage.locator("html")).toHaveAttribute("data-theme", "paper");

  const storagePage = await page.context().newPage();
  await storagePage.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage is unavailable", "SecurityError");
      },
    });
  });
  await storagePage.emulateMedia({ colorScheme: "dark" });
  await storagePage.goto("/");
  await storagePage.getByRole("button", { name: "Open demo repository" }).click();
  await expect(storagePage.locator("html")).toHaveAttribute("data-theme", "night-owl");
  await storagePage.getByRole("button", { name: "Use Paper theme" }).click();
  await storagePage.emulateMedia({ colorScheme: "light" });
  await expect(storagePage.locator("html")).toHaveAttribute("data-theme", "paper");
});

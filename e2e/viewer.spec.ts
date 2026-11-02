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
      "alice-agent-with-an-extraordinarily-long-name-for-overflow-checks",
      "release",
      1,
      "info",
      "A separate topic for the conversation list.",
      "bob-agent",
      parent.id,
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
  const arrivalOne = makeMessage(
    "2026-10-09",
    "1030",
    "bob-agent",
    "api",
    99,
    "info",
    "A new synthetic message arrives after refresh.",
    "all",
  );
  const arrivalTwo = makeMessage(
    "2026-10-09",
    "1031",
    "alice-agent",
    "api",
    30,
    "info",
    "A second synthetic message arrives after refresh.",
    "all",
  );
  const blobs = new Map<string, string>([["marker", "collab-protocol: 1\n"]]);
  const unhandled: string[] = [];
  let headCalls = 0;
  let completedHeadCalls = 0;

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
        completedHeadCalls += 1;
      } else {
        const revision = Math.min(headCalls, 3);
        await json(route, { object: { sha: `revision-${revision}` } }, 200, {
          etag: `"revision-${revision}"`,
        });
        completedHeadCalls += 1;
      }
      return;
    }

    if (
      ["revision-1", "revision-2", "revision-3"].some((revision) =>
        path.endsWith(`/git/commits/${revision}`),
      )
    ) {
      const version = path.slice(path.lastIndexOf("-") + 1);
      await json(route, { tree: { sha: `root-${version}` } });
      return;
    }

    if (["1", "2", "3"].some((version) => path.endsWith(`/git/trees/root-${version}`))) {
      const version = path.slice(path.lastIndexOf("-") + 1);
      await json(route, {
        truncated: false,
        tree: [
          treeEntry(".agent-collab", "marker", "blob"),
          treeEntry("inbox", `inbox-${version}`, "tree"),
        ],
      });
      return;
    }

    if (["1", "2", "3"].some((version) => path.endsWith(`/git/trees/inbox-${version}`))) {
      const version = path.slice(path.lastIndexOf("-") + 1);
      const fixtureMessages =
        mode !== "long" || version === "1"
          ? messages
          : version === "2"
            ? [...messages, arrivalOne]
            : [...messages, arrivalOne, arrivalTwo];
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
  return Object.assign(
    () => {
      expect(unhandled, "the app must make only fixture-backed API requests").toEqual([]);
    },
    { completedHeadCalls: () => completedHeadCalls },
  );
}

async function openViewer(page: Page, mode: "long" | "empty" | "error") {
  const assertRequests = await installApiStub(page, mode);
  await page.goto("/");
  await page.getByRole("button", { name: "Open another repository" }).click();
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
  const longSender = page.locator(".sender").last();
  await expect(longSender).toHaveAttribute(
    "title",
    "alice-agent-with-an-extraordinarily-long-name-for-overflow-checks",
  );
  const senderBox = await longSender.boundingBox();
  expect(senderBox).not.toBeNull();
  expect((senderBox?.x ?? 0) + (senderBox?.width ?? 0)).toBeLessThanOrEqual(1280);
  await saveScreenshot(page, "desktop-night-owl.png");

  await page.getByRole("button", { name: "Use Paper theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f4f3ed");
  await expect(
    page.evaluate(() => localStorage.getItem("agent-collab-viewer.theme")),
  ).resolves.toBe("paper");
  await saveScreenshot(page, "desktop-paper.png");

  const refresh = page.getByRole("button", { name: "Refresh" });
  const headsBeforeArrival = assertRequests.completedHeadCalls();
  await refresh.click();
  await expect.poll(() => assertRequests.completedHeadCalls()).toBe(headsBeforeArrival + 1);
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("status")).toHaveText(
    "1 new message arrived. 1 new message since opening this view.",
  );
  await expect(page.getByRole("separator", { name: "New messages" })).toBeVisible();
  await expect(page.getByText("A new synthetic message arrives after refresh.")).toBeVisible();
  const liveRegion = page.locator('[aria-live="polite"][aria-atomic="true"]');
  await liveRegion.evaluate((region) => {
    region.setAttribute("data-mutation-count", "0");
    new MutationObserver(() => {
      const count = Number(region.getAttribute("data-mutation-count")) + 1;
      region.setAttribute("data-mutation-count", String(count));
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });
  const mutationsBeforeUnchangedRefresh = Number(
    await liveRegion.getAttribute("data-mutation-count"),
  );
  const headsBeforeSecondArrival = assertRequests.completedHeadCalls();
  await refresh.click();
  await expect.poll(() => assertRequests.completedHeadCalls()).toBe(headsBeforeSecondArrival + 1);
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(liveRegion).toHaveAttribute(
    "data-mutation-count",
    String(mutationsBeforeUnchangedRefresh + 1),
  );
  await expect(liveRegion).toHaveText(
    "1 new message arrived. 2 new messages since opening this view.",
  );
  await expect(page.getByText("A second synthetic message arrives after refresh.")).toBeVisible();
  const mutationsBeforeUnchanged = Number(await liveRegion.getAttribute("data-mutation-count"));
  const headsBeforeUnchanged = assertRequests.completedHeadCalls();
  await refresh.click();
  await expect.poll(() => assertRequests.completedHeadCalls()).toBe(headsBeforeUnchanged + 1);
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(liveRegion).toHaveAttribute("data-mutation-count", String(mutationsBeforeUnchanged));
  await expect(liveRegion).toHaveText(
    "1 new message arrived. 2 new messages since opening this view.",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".topics-pane")).toBeVisible();
  await expect(page.locator(".conversation")).toBeHidden();
  await expect(page.getByRole("link", { name: "Jump to latest" })).toBeHidden();
  await page.getByRole("button", { name: "#release" }).click();
  await expect(page.locator(".topics-pane")).toBeHidden();
  await expect(page.locator(".conversation")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to conversations" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Jump to latest" })).toBeVisible();
  await expect(page.locator("#conversation-heading")).toBeFocused();
  await expect(page.locator(".quote.missing")).toContainText("parent not shown");
  await expect(page.locator(".quote[href]")).toHaveCount(0);
  const phoneSender = page.locator(".sender").last();
  const senderLayout = await phoneSender.evaluate((sender) => {
    const conversation = sender.closest(".conversation") ?? document.querySelector(".conversation");
    const senderBox = sender.getBoundingClientRect();
    const conversationBox = conversation?.getBoundingClientRect();
    const style = getComputedStyle(sender);
    return {
      clientWidth: sender.clientWidth,
      scrollWidth: sender.scrollWidth,
      whiteSpace: style.whiteSpace,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      senderLeft: senderBox.left,
      senderRight: senderBox.right,
      conversationLeft: conversationBox?.left ?? 0,
      conversationRight: conversationBox?.right ?? 0,
    };
  });
  expect(senderLayout.scrollWidth).toBeGreaterThan(senderLayout.clientWidth);
  expect(senderLayout.whiteSpace).toBe("nowrap");
  expect(senderLayout.overflow).toBe("hidden");
  expect(senderLayout.textOverflow).toBe("ellipsis");
  expect(senderLayout.senderLeft).toBeGreaterThanOrEqual(senderLayout.conversationLeft);
  expect(senderLayout.senderRight).toBeLessThanOrEqual(senderLayout.conversationRight);
  await expect(phoneSender).toHaveAttribute(
    "aria-label",
    "alice-agent-with-an-extraordinarily-long-name-for-overflow-checks",
  );
  await saveScreenshot(page, "phone-paper.png");
  await page.getByRole("button", { name: "Back to conversations" }).click();
  await expect(page.locator(".topics-pane")).toBeVisible();
  await expect(page.locator(".conversation")).toBeHidden();
  await expect(page.getByRole("button", { name: "#release" })).toBeFocused();

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

test("welcome screen exposes live-demo, saved-repository, and theme controls", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agent collaboration viewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open live demo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open saved repository" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open another repository" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use Paper theme" })).toBeVisible();
  await saveScreenshot(page, "welcome-night-owl.png");
  await page.getByRole("button", { name: "Use Paper theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await saveScreenshot(page, "welcome-paper.png");
  await page.getByRole("button", { name: "Use Night Owl theme" }).click();

  await page.getByRole("button", { name: "Open saved repository" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use Paper theme" })).toBeVisible();
  await page.getByRole("button", { name: "Open offline demo" }).click();
  await expect(page.getByRole("heading", { name: "Demo repository" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night-owl");
  await expect(page.locator(".bubble").first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
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
  let appModuleRequested = () => {};
  const appModuleRequest = new Promise<void>((resolveAppModule) => {
    appModuleRequested = resolveAppModule;
  });
  let releaseAppModule = () => {};
  const appModuleGate = new Promise<void>((resolveAppModule) => {
    releaseAppModule = resolveAppModule;
  });
  await preferencePage.route("**/assets/index-*.js", async (route) => {
    appModuleRequested();
    await appModuleGate;
    await route.continue();
  });
  await preferencePage.goto("/", { waitUntil: "commit" });
  await appModuleRequest;
  await expect(preferencePage.locator("html")).toHaveAttribute("data-theme", "paper");
  releaseAppModule();
  await expect(preferencePage.locator("html")).toHaveAttribute("data-theme", "paper");
  await expect(preferencePage.getByRole("button", { name: "Open live demo" })).toBeVisible();
  await expect(preferencePage.getByRole("button", { name: "Use Night Owl theme" })).toBeVisible();
  await preferencePage.getByRole("button", { name: "Open another repository" }).click();
  await expect(preferencePage.getByRole("button", { name: "Use Night Owl theme" })).toBeVisible();
  await preferencePage.getByRole("button", { name: "Open offline demo" }).click();
  await expect(preferencePage.locator("html")).toHaveAttribute("data-theme", "paper");

  const systemThemePage = await page.context().newPage();
  await systemThemePage.addInitScript(() => {
    localStorage.removeItem("agent-collab-viewer.theme");
  });
  await systemThemePage.emulateMedia({ colorScheme: "dark" });
  await systemThemePage.goto("/");
  await expect(systemThemePage.locator("html")).toHaveAttribute("data-theme", "night-owl");
  await systemThemePage.emulateMedia({ colorScheme: "light" });
  await expect(systemThemePage.locator("html")).toHaveAttribute("data-theme", "paper");

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
  await storagePage.getByRole("button", { name: "Open another repository" }).click();
  await storagePage.getByRole("button", { name: "Open offline demo" }).click();
  await expect(storagePage.locator("html")).toHaveAttribute("data-theme", "night-owl");
  await storagePage.getByRole("button", { name: "Use Paper theme" }).click();
  await storagePage.emulateMedia({ colorScheme: "light" });
  await expect(storagePage.locator("html")).toHaveAttribute("data-theme", "paper");

  const writeFailurePage = await page.context().newPage();
  await writeFailurePage.addInitScript(() => {
    const original = Storage.prototype.setItem.bind(localStorage);
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "agent-collab-viewer.theme") {
        throw new DOMException("Theme preference is read-only", "QuotaExceededError");
      }
      original(key, value);
    };
  });
  const assertWriteFailureRequests = await openViewer(writeFailurePage, "empty");
  await writeFailurePage.getByRole("button", { name: /Use (Paper|Night Owl) theme/ }).click();
  await writeFailurePage.getByRole("button", { name: "Settings" }).click();
  await expect(
    writeFailurePage.getByRole("textbox", { name: "Repository", exact: true }),
  ).toHaveValue("alice-agent/fixture-repo");
  assertWriteFailureRequests();
});

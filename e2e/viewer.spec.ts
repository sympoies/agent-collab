import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import { en, LOCALE_NAMES, LOCALES } from "../src/i18n/catalog";
import { ja } from "../src/i18n/ja";
import { zhTW } from "../src/i18n/zh-TW";
import { formatDateTime } from "../src/i18n/translate";

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
  refs = "",
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
      `refs: ${refs}`.trimEnd(),
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

function questionThread(): MessageFixture[] {
  const open = makeMessage(
    "2026-10-08",
    "0900",
    "alice-agent",
    "api",
    1,
    "question",
    "Is the schema final?",
  );
  const answered = makeMessage(
    "2026-10-08",
    "0905",
    "bob-agent",
    "api",
    2,
    "question",
    "Can the field be optional?",
    "alice-agent",
  );
  const concluded = makeMessage(
    "2026-10-08",
    "0910",
    "alice-agent",
    "ops",
    1,
    "question",
    "Which region ships first?",
  );
  return [
    open,
    makeMessage(
      "2026-10-08",
      "0901",
      "bob-agent",
      "api",
      3,
      "ack",
      "Received. Expected reply: within 10 minutes",
      "alice-agent",
      open.id,
    ),
    makeMessage(
      "2026-10-08",
      "0902",
      "bob-agent",
      "api",
      5,
      "ack",
      "Looking into the schema. Blocked on the review.",
      "alice-agent",
      open.id,
    ),
    answered,
    makeMessage(
      "2026-10-08",
      "0906",
      "alice-agent",
      "api",
      4,
      "answer",
      "Yes, it can.",
      "bob-agent",
      answered.id,
    ),
    concluded,
    makeMessage(
      "2026-10-08",
      "0911",
      "bob-agent",
      "ops",
      2,
      "answer",
      "North.",
      "alice-agent",
      concluded.id,
    ),
    makeMessage(
      "2026-10-08",
      "0912",
      "alice-agent",
      "ops",
      3,
      "info",
      "We chose North.",
      "bob-agent",
      concluded.id,
    ),
  ];
}

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const TOPIC_FILES: Readonly<Record<string, { sha: string; body: string | Buffer }>> = {
  "fields-v1.md": {
    sha: "topic-md",
    body: "# Field list\n\n- **id** is required\n- `note` is optional\n\n<script>window.pwned = true</script>\n",
  },
  "results.csv": { sha: "topic-csv", body: 'name,score\nalice,"9, great"\nbob,7\n' },
  "diagram.png": { sha: "topic-png", body: Buffer.from(PNG_BASE64, "base64") },
  "archive.bin": { sha: "topic-bin", body: "opaque bytes" },
};

function attachmentThread(): MessageFixture[] {
  const first = makeMessage(
    "2026-10-08",
    "0900",
    "alice-agent",
    "api",
    1,
    "info",
    "The review files are attached.",
    "bob-agent",
    "",
    "topics/api/fields-v1.md, topics/api/results.csv, topics/api/diagram.png, topics/api/archive.bin, https://docs.example.com/guide, topics/api/other.md, topics/api/an-extraordinarily-long-file-name-that-keeps-going-and-going-for-the-phone-viewport-check-0123456789.md, https://a-very-long-host-name-for-the-wrapping-check-at-phone-width.example.invalid/path, 2026-10-08T0910-alice-agent-ops-01",
  );
  return [
    first,
    makeMessage(
      "2026-10-08",
      "0910",
      "alice-agent",
      "ops",
      1,
      "info",
      "An operations note in another topic.",
    ),
    makeMessage(
      "2026-10-08",
      "0905",
      "bob-agent",
      "api",
      2,
      "info",
      "Looks good; see my earlier message.",
      "alice-agent",
      "",
      first.id,
    ),
  ];
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

async function installApiStub(
  page: Page,
  mode: "long" | "questions" | "attachments" | "empty" | "error",
) {
  const messages =
    mode === "long"
      ? longThread()
      : mode === "questions"
        ? questionThread()
        : mode === "attachments"
          ? attachmentThread()
          : [];
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
  const blobs = new Map<string, string>([
    ["marker", "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n"],
  ]);
  const unhandled: string[] = [];
  const topicBlobRequests: string[] = [];
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
          ...(mode === "attachments" ? [treeEntry("topics", "topics-tree", "tree")] : []),
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

    if (path.endsWith("/git/trees/topics-tree")) {
      await json(route, { truncated: false, tree: [treeEntry("api", "api-tree", "tree")] });
      return;
    }
    if (path.endsWith("/git/trees/api-tree")) {
      await json(route, {
        truncated: false,
        tree: Object.entries(TOPIC_FILES).map(([name, file]) => ({
          ...treeEntry(name, file.sha, "blob"),
          size: Buffer.byteLength(file.body),
        })),
      });
      return;
    }
    const topicFile = Object.values(TOPIC_FILES).find((file) =>
      path.endsWith(`/git/blobs/${file.sha}`),
    );
    if (topicFile !== undefined) {
      topicBlobRequests.push(path);
      await route.fulfill({ status: 200, body: topicFile.body });
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
    {
      completedHeadCalls: () => completedHeadCalls,
      topicBlobRequests: () => topicBlobRequests.length,
    },
  );
}

async function openViewer(
  page: Page,
  mode: "long" | "questions" | "attachments" | "empty" | "error",
) {
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
  await expect(page.locator(".message")).toHaveCount(30);
  await expect(page.locator(".day")).toHaveCount(2);
  await expect(page.locator(".group").first().locator(".message")).toHaveCount(2);
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
  await expect(failedPage.getByRole("alert")).toContainText(en["error.unexpected"]);
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
  await expect(page.locator(".message").first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("keyboard focus, topic filtering, reduced motion, and unavailable storage work", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const assertRequests = await openViewer(page, "long");
  await expect(page.locator(".message").first()).toBeVisible();

  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => ({
    label: document.activeElement?.textContent,
    outlineStyle: getComputedStyle(document.activeElement as Element).outlineStyle,
    outlineWidth: getComputedStyle(document.activeElement as Element).outlineWidth,
  }));
  expect(focused.label).toBe("Refresh");
  expect(focused.outlineStyle).toBe("solid");
  expect(focused.outlineWidth).toBe("3px");

  // Viewing as, Profile & colors, Local folder, language, theme, Settings, Questions, Files, All, then the first topic.
  for (let tab = 0; tab < 10; tab += 1) await page.keyboard.press("Tab");
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
  const writeFailurePageErrors: string[] = [];
  writeFailurePage.on("pageerror", (error) => writeFailurePageErrors.push(error.message));
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
  expect(writeFailurePageErrors).toEqual([]);
  assertWriteFailureRequests();

  const settingsFailurePage = await page.context().newPage();
  const settingsFailurePageErrors: string[] = [];
  settingsFailurePage.on("pageerror", (error) => settingsFailurePageErrors.push(error.message));
  await settingsFailurePage.addInitScript(() => {
    const original = Storage.prototype.setItem.bind(localStorage);
    const failedKeys = new Set(["agent-collab-viewer.theme", "agent-collab-viewer.settings"]);
    Storage.prototype.setItem = function (key: string, value: string) {
      if (failedKeys.has(key)) {
        throw new DOMException("Viewer setting is read-only", "QuotaExceededError");
      }
      original(key, value);
    };
  });
  const assertSettingsFailureRequests = await openViewer(settingsFailurePage, "empty");
  await expect(
    settingsFailurePage.getByRole("heading", { name: "alice-agent/fixture-repo" }),
  ).toBeVisible();
  await settingsFailurePage.getByRole("button", { name: /Use (Paper|Night Owl) theme/ }).click();
  await settingsFailurePage.getByRole("button", { name: "Settings" }).click();
  await expect(
    settingsFailurePage.getByRole("textbox", { name: "Repository", exact: true }),
  ).toHaveValue("alice-agent/fixture-repo");
  expect(settingsFailurePageErrors).toEqual([]);
  assertSettingsFailureRequests();
});

test("a live-demo rate limit keeps the snapshot visible", async ({ page }) => {
  const id = "2026-11-03T0900-alice-agent-api-01";
  const snapshot = {
    schemaVersion: 1,
    generatedAt: "2026-11-03T08:00:00.000Z",
    revision: "snapshot-tree",
    files: [
      { path: ".agent-collab", text: "collab-protocol: 1\nparticipants: alice-agent\n" },
      {
        path: `inbox/${id}.md`,
        text: [
          "---",
          `id: ${id}`,
          "from: alice-agent",
          "to:",
          "topic: api",
          "type: info",
          "reply_to:",
          "refs:",
          "needs: none",
          "due:",
          "---",
          "Snapshot remains available after an API rate limit.",
        ].join("\n"),
      },
    ],
  };
  await page.route("**/demo-snapshot.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshot),
    }),
  );
  const requests: string[] = [];
  await page.route("https://api.github.com/**", async (route) => {
    requests.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      headers: {
        "access-control-allow-origin": "*",
        "access-control-expose-headers":
          "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
        "retry-after": "3600",
      },
      body: JSON.stringify({ message: "Synthetic rate limit" }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open live demo" }).click();
  await expect(page.getByText("Snapshot remains available after an API rate limit.")).toBeVisible();
  await expect(
    page.getByText(formatDateTime("en", new Date("2026-11-03T08:00:00.000Z"))),
  ).toBeVisible();
  expect(requests).toEqual([]);

  await page.getByRole("button", { name: "Check live now" }).click();
  await expect(page.getByText("Snapshot remains available after an API rate limit.")).toBeVisible();
  await expect(page.locator(".notice")).toContainText("Next live check");
  const requestsAfterLimit = requests.length;
  expect(requestsAfterLimit).toBeGreaterThan(0);

  // Until the reset, further checks and a reopened demo make no API request.
  await page.getByRole("button", { name: "Check live now" }).click();
  await expect(page.locator(".notice")).toContainText("paused");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open live demo" }).click();
  await expect(page.getByText("Snapshot remains available after an API rate limit.")).toBeVisible();
  expect(requests).toHaveLength(requestsAfterLimit);
});

const identityCases = [
  {
    label: "desktop",
    theme: "night-owl",
    scheme: "dark",
    viewport: { width: 1280, height: 800 },
    alice: "rgb(247, 140, 108)",
    bob: "rgb(173, 219, 103)",
    teal: "rgb(127, 219, 202)",
    onPerson: "rgb(1, 22, 39)",
  },
  {
    label: "desktop",
    theme: "paper",
    scheme: "light",
    viewport: { width: 1280, height: 800 },
    alice: "rgb(175, 78, 28)",
    bob: "rgb(45, 108, 63)",
    teal: "rgb(10, 118, 133)",
    onPerson: "rgb(255, 255, 255)",
  },
  {
    label: "phone",
    theme: "night-owl",
    scheme: "dark",
    viewport: { width: 390, height: 844 },
    alice: "rgb(247, 140, 108)",
    bob: "rgb(173, 219, 103)",
    teal: "rgb(127, 219, 202)",
    onPerson: "rgb(1, 22, 39)",
  },
  {
    label: "phone",
    theme: "paper",
    scheme: "light",
    viewport: { width: 390, height: 844 },
    alice: "rgb(175, 78, 28)",
    bob: "rgb(45, 108, 63)",
    teal: "rgb(10, 118, 133)",
    onPerson: "rgb(255, 255, 255)",
  },
] as const;

for (const identity of identityCases) {
  test(`Viewing as, person colors and Profile & colors work on ${identity.label} in ${identity.theme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: identity.scheme });
    await page.setViewportSize(identity.viewport);
    const assertRequests = await openViewer(page, "long");
    await expect(page.locator("html")).toHaveAttribute("data-theme", identity.theme);
    await page.getByRole("button", { name: /^#api/ }).click();
    await expect(page.locator(".message").first()).toBeVisible();

    await expect(page.locator(".bar-actions button").first()).toHaveText("Refresh");

    // "My names" makes alice the default viewer: her groups carry the You tag.
    const firstGroup = page.locator(".timeline .group").first();
    await expect(page.getByLabel("Viewing as")).toHaveValue("alice-agent");
    await expect(page.locator('.group[data-own="true"] .you').first()).toHaveText("You");
    await expect(firstGroup.locator(".sender")).toHaveCSS("color", identity.alice);
    await expect(firstGroup.locator(".avatar")).toHaveCSS("background-color", identity.alice);
    await expect(firstGroup.locator(".avatar")).toHaveCSS("color", identity.onPerson);
    const bobGroup = page
      .locator(".timeline .group")
      .filter({ has: page.locator(".sender", { hasText: /^bob-agent$/ }) })
      .first();
    await expect(bobGroup.locator(".sender")).toHaveCSS("color", identity.bob);
    await expect(bobGroup.locator(".you")).toHaveCount(0);

    // Messages that name bob are highlighted when viewing as bob, and nothing is marked as Observer.
    await page.getByLabel("Viewing as").selectOption("bob-agent");
    await expect(page.locator('.group[data-own="true"] .sender').first()).toHaveText("bob-agent");
    await expect(page.locator('.message[data-addressed="true"]').first()).toBeVisible();
    await page.getByLabel("Viewing as").selectOption("");
    await expect(page.locator(".you")).toHaveCount(0);
    await expect(page.locator('.message[data-addressed="true"]')).toHaveCount(0);
    await page.getByLabel("Viewing as").selectOption("alice-agent");

    await page.getByRole("button", { name: "Profile & colors" }).click();
    const panel = page.getByRole("region", { name: "Profile & colors" });
    await expect(panel).toBeVisible();
    await panel
      .getByRole("group", { name: "Color for alice-agent", exact: true })
      .getByRole("radio", { name: "Teal" })
      .check();
    await expect(firstGroup.locator(".sender")).toHaveCSS("color", identity.teal);
    await expect(firstGroup.locator(".avatar")).toHaveCSS("background-color", identity.teal);
    await panel.getByLabel("Display name for alice-agent", { exact: true }).fill("Alice");
    await panel.getByLabel("Display name for alice-agent", { exact: true }).blur();
    await expect(firstGroup.locator(".sender")).toHaveText("Alice");
    await expect(firstGroup.locator(".sender")).toHaveAttribute("title", "alice-agent");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await saveScreenshot(page, `identity-${identity.label}-${identity.theme}.png`);

    await panel.getByRole("button", { name: "Reset colors and names" }).click();
    await expect(firstGroup.locator(".sender")).toHaveText("alice-agent");
    await expect(firstGroup.locator(".sender")).toHaveCSS("color", identity.alice);
    assertRequests();
  });
}

test("identity choices still work when browser storage rejects reads and writes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem.bind(localStorage);
    const originalGet = Storage.prototype.getItem.bind(localStorage);
    const counts = { rejectedWrites: 0, rejectedReads: 0 };
    Object.assign(window, { identityStorageCounts: counts });
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("agent-collab-viewer.identity:")) {
        counts.rejectedWrites += 1;
        throw new DOMException("Identity preferences are read-only", "QuotaExceededError");
      }
      original(key, value);
    };
    Storage.prototype.getItem = function (key: string) {
      if (key.startsWith("agent-collab-viewer.identity:")) {
        counts.rejectedReads += 1;
        throw new DOMException("Identity preferences are unreadable", "SecurityError");
      }
      return originalGet(key);
    };
  });
  const assertRequests = await openViewer(page, "long");
  await expect(page.locator(".message").first()).toBeVisible();
  await page.getByLabel("Viewing as").selectOption("bob-agent");
  await expect(page.locator('.group[data-own="true"] .sender').first()).toHaveText("bob-agent");
  const counts = await page.evaluate(
    () =>
      (
        window as unknown as {
          identityStorageCounts: { rejectedWrites: number; rejectedReads: number };
        }
      ).identityStorageCounts,
  );
  expect(counts.rejectedReads).toBeGreaterThan(0);
  expect(counts.rejectedWrites).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  assertRequests();
});

for (const identity of identityCases) {
  test(`receipts and the Questions view work on ${identity.label} in ${identity.theme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: identity.scheme });
    await page.setViewportSize(identity.viewport);
    const assertRequests = await openViewer(page, "questions");
    await expect(page.locator("html")).toHaveAttribute("data-theme", identity.theme);
    const phone = identity.viewport.width < 721;
    if (phone) await page.getByRole("button", { name: /^#api/ }).click();

    // The acknowledgement is a receipt under its question, not a row of its own.
    const question = page.locator("#msg-2026-10-08T0900-alice-agent-api-01");
    await expect(question).toBeVisible();
    await expect(question.locator(".ack-receipt")).toContainText(
      "bob-agent acknowledged 09:01 · reply expected within 10 minutes",
    );
    await expect(question.locator(".question-progress")).toContainText("0/1 answered");
    await expect(page.locator(".message", { hasText: "Received. Expected reply" })).toHaveCount(0);
    await question.getByText("Recipients").click();
    await expect(question.locator(".recipients")).toContainText("no read receipt");
    await expect(question.locator(".recipients li")).toContainText("bob-agent acknowledged 09:02");
    // An acknowledgement with its own text keeps its row and stays readable.
    await expect(
      page.locator(".message", { hasText: "Looking into the schema. Blocked on the review." }),
    ).toBeVisible();

    const answered = page.locator(".message", { hasText: "Can the field be optional?" });
    await expect(answered.locator(".question-progress")).toContainText("1/1 answered");
    await saveScreenshot(page, `receipts-${identity.label}-${identity.theme}.png`);

    if (phone) await page.getByRole("button", { name: "Back to conversations" }).click();
    await page.getByRole("button", { name: /^Questions/ }).click();
    await expect(page.locator("#conversation-heading")).toHaveText("Questions");
    const open = page.getByRole("region", { name: "Open" });
    await expect(open.locator(".question-text")).toHaveText(["Is the schema final?"]);
    await expect(
      page.getByRole("region", { name: "Answered" }).locator(".question-text"),
    ).toHaveText(["Can the field be optional?"]);
    const concluded = page.getByRole("region", { name: "Concluded" });
    await expect(concluded.locator(".question-text")).toHaveText(["Which region ships first?"]);
    await expect(concluded.locator(".conclusion-text")).toHaveText("We chose North.");
    await expect(open.locator(".you")).toHaveCount(0);
    await page.getByLabel("Viewing as").selectOption("bob-agent");
    await expect(open.locator(".you")).toHaveText("Waiting for you");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await saveScreenshot(page, `questions-${identity.label}-${identity.theme}.png`);

    await concluded.locator(".question-link").click();
    await expect(page.locator("#conversation-heading")).toHaveText("#ops");
    const jumped = page.locator("#msg-2026-10-08T0910-alice-agent-ops-01");
    await expect(jumped).toBeInViewport();
    await expect(jumped.locator(".conclusion")).toContainText("We chose North.");
    assertRequests();
  });
}

for (const identity of identityCases) {
  test(`attachments, previews and the Files view work on ${identity.label} in ${identity.theme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: identity.scheme });
    await page.setViewportSize(identity.viewport);
    const assertRequests = await openViewer(page, "attachments");
    await expect(page.locator("html")).toHaveAttribute("data-theme", identity.theme);
    const phone = identity.viewport.width < 721;
    await page.getByRole("button", { name: /^#api/ }).click();

    const first = page.locator("#msg-2026-10-08T0900-alice-agent-api-01");
    await expect(first.locator(".file-card")).toHaveCount(6);
    await expect(first.locator(".file-badge")).toHaveText(["MD", "CSV", "IMG", "FILE", "MD", "MD"]);
    const guide = first.getByRole("link", { name: "docs.example.com" });
    await expect(guide).toHaveAttribute("rel", "noopener noreferrer");
    await expect(guide).toHaveAttribute("target", "_blank");
    // No file was requested before a card was opened.
    expect(assertRequests.topicBlobRequests()).toBe(0);

    const card = (name: string) => first.locator(".file-card", { hasText: name });
    await card("fields-v1.md").locator("summary").click();
    await expect(card("fields-v1.md").getByRole("heading", { name: "Field list" })).toBeVisible();
    await expect(card("fields-v1.md").locator("strong")).toHaveText("id");
    await expect(card("fields-v1.md")).toContainText("<script>window.pwned = true</script>");
    expect(await page.evaluate(() => "pwned" in window)).toBe(false);

    await card("results.csv").locator("summary").click();
    await expect(card("results.csv").locator("td")).toHaveText(["alice", "9, great", "bob", "7"]);

    await card("diagram.png").locator("summary").click();
    const image = card("diagram.png").locator("img");
    await expect(image).toBeVisible();
    expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);

    await card("archive.bin").locator("summary").click();
    // The link points at the revision being viewed, not at a moving branch.
    await expect(card("archive.bin")).toContainText("No preview for this file type.");
    await expect(card("archive.bin").getByRole("link", { name: "Open in GitHub" })).toHaveAttribute(
      "href",
      /^https:\/\/github\.com\/alice-agent\/fixture-repo\/blob\/revision-\d+\/topics\/api\/archive\.bin$/,
    );

    await card("other.md").locator("summary").click();
    await expect(card("other.md")).toContainText("not in the repository at this revision");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await saveScreenshot(page, `attachments-${identity.label}-${identity.theme}.png`);

    // A message id jumps to that message and highlights it.
    await page
      .locator("#msg-2026-10-08T0905-bob-agent-api-02")
      .getByRole("link", { name: /^Message 2026-10-08 09:00/ })
      .click();
    await expect(page.locator("#msg-2026-10-08T0900-alice-agent-api-01")).toHaveCSS(
      "outline-style",
      "solid",
    );

    // A reference to a message of another topic switches to that topic.
    await first.getByRole("link", { name: /^Message 2026-10-08 09:10/ }).click();
    await expect(page.locator("#conversation-heading")).toHaveText("#ops");
    await expect(page.locator("#msg-2026-10-08T0910-alice-agent-ops-01")).toHaveCSS(
      "outline-style",
      "solid",
    );

    if (phone) await page.getByRole("button", { name: "Back to conversations" }).click();
    await page.getByRole("button", { name: "All" }).click();
    if (phone) await page.getByRole("button", { name: "Back to conversations" }).click();
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.locator("#conversation-heading")).toHaveText("Files");
    await expect(page.locator(".files .file-name")).toHaveCount(6);
    await expect(page.locator(".files .file-from").first()).toContainText("alice-agent · #api");
    await expect(page.locator(".files a.chip")).toHaveCount(2);
    const filesOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(filesOverflow).toBeLessThanOrEqual(0);
    await saveScreenshot(page, `files-${identity.label}-${identity.theme}.png`);

    // The sender line of a file jumps back to the chat at that message.
    await page.locator(".files .file-from").first().click();
    await expect(page.locator("#conversation-heading")).toHaveText("All conversations");
    await expect(page.locator("#msg-2026-10-08T0900-alice-agent-api-01")).toHaveCSS(
      "outline-style",
      "solid",
    );
    assertRequests();
  });
}

const CLONE_MARKER = "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n";

function cloneMessage(id: string, from: string, body: string): string {
  return [
    "---",
    `id: ${id}`,
    `from: ${from}`,
    "to: all",
    "topic: api",
    "type: info",
    "reply_to:",
    "refs:",
    "needs: none",
    "due:",
    "---",
    body,
  ].join("\n");
}

/**
 * Stands in for the browser's folder picker with an in-memory clone, so the real production code
 * path (feature detection, picker, source, polling) runs without a native dialog. The page can
 * change the clone through window.fakeClone, like a background `git pull` would.
 */
async function installFakeFolder(
  page: Page,
  options: { picker: "works" | "cancels" | "missing" | "not-a-clone" },
) {
  await page.addInitScript(
    ({ mode, marker, first }) => {
      if (mode === "missing") {
        Reflect.deleteProperty(window, "showDirectoryPicker");
        return;
      }
      class FakeFile {
        readonly kind = "file";
        constructor(
          readonly name: string,
          public content: string,
          public modified: number,
        ) {}
        getFile() {
          const blob = new Blob([this.content]);
          Object.defineProperty(blob, "lastModified", { value: this.modified });
          const content = this.content;
          Object.defineProperty(blob, "text", {
            value: () => {
              counts.textReads += 1;
              return Promise.resolve(content);
            },
          });
          counts.metadataReads += 1;
          return Promise.resolve(blob);
        }
      }
      class FakeDirectory {
        readonly kind = "directory";
        readonly children = new Map<string, FakeFile | FakeDirectory>();
        constructor(readonly name: string) {}
        async *values() {
          await Promise.resolve();
          yield* this.children.values();
        }
        getDirectoryHandle(name: string) {
          const child = this.children.get(name);
          if (!(child instanceof FakeDirectory)) {
            return Promise.reject(new DOMException("missing", "NotFoundError"));
          }
          return Promise.resolve(child);
        }
        getFileHandle(name: string) {
          const child = this.children.get(name);
          if (!(child instanceof FakeFile)) {
            return Promise.reject(new DOMException("missing", "NotFoundError"));
          }
          return Promise.resolve(child);
        }
        queryPermission() {
          return Promise.resolve(state.permission);
        }
      }
      const counts = { textReads: 0, metadataReads: 0, picks: 0 };
      const state = { permission: "granted" };
      const root = new FakeDirectory("demo-clone");
      const write = (path: string, content: string, modified: number) => {
        const segments = path.split("/");
        const name = segments.pop() ?? "";
        let directory = root;
        for (const segment of segments) {
          let child = directory.children.get(segment);
          if (!(child instanceof FakeDirectory)) {
            child = new FakeDirectory(segment);
            directory.children.set(segment, child);
          }
          directory = child;
        }
        const existing = directory.children.get(name);
        if (existing instanceof FakeFile) {
          existing.content = content;
          existing.modified = modified;
        } else directory.children.set(name, new FakeFile(name, content, modified));
      };
      if (mode !== "not-a-clone") write(".agent-collab", marker, Date.now() - 3_600_000);
      write("inbox/2026-10/2026-10-08T0900-alice-agent-api-01.md", first, Date.now() - 10 * 60_000);
      Object.assign(window, {
        fakeClone: { write, counts, state },
        showDirectoryPicker: () => {
          counts.picks += 1;
          return mode === "cancels"
            ? Promise.reject(new DOMException("user closed it", "AbortError"))
            : Promise.resolve(root);
        },
      });
    },
    {
      mode: options.picker,
      marker: CLONE_MARKER,
      first: cloneMessage(
        "2026-10-08T0900-alice-agent-api-01",
        "alice-agent",
        "The first message from the local clone.",
      ),
    },
  );
}

for (const view of [
  { label: "desktop", scheme: "dark", theme: "night-owl", size: { width: 1280, height: 800 } },
  { label: "phone", scheme: "light", theme: "paper", size: { width: 390, height: 844 } },
] as const) {
  test(`a local folder opens, labels itself, polls for changes and shows when it last changed on ${view.label}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: view.scheme });
    await page.setViewportSize(view.size);
    await page.clock.install({ time: new Date() });
    await installFakeFolder(page, { picker: "works" });
    const requests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1") requests.push(url.hostname);
    });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", view.theme);
    await page.getByRole("button", { name: "Open local folder (experimental)" }).click();

    await expect(page.getByRole("heading", { name: "Local folder: demo-clone" })).toBeVisible();
    if (view.size.width < 721) await page.getByRole("button", { name: /^#api/ }).click();
    await expect(page.getByText("The first message from the local clone.")).toBeVisible();
    const indicator = page.locator(".source-indicator");
    await expect(indicator).toContainText("Local folder · experimental");
    await expect(indicator.locator(".last-changed")).toHaveText(
      /^Last change seen (just now|1 minute ago|\d+ minutes ago)$/,
    );
    await expect(indicator.locator(".last-changed")).toHaveAttribute(
      "title",
      /file modification time/,
    );
    await saveScreenshot(page, `local-folder-${view.label}-${view.theme}.png`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // A poll of an unchanged folder reads no message text and publishes nothing new. The metadata
    // counter proves a poll really ran: it rises by one read per scanned file.
    const counts = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              fakeClone: { counts: { textReads: number; metadataReads: number } };
            }
          ).fakeClone.counts,
      );
    const messagesBefore = await page.locator(".message").count();
    const before = await counts();
    await page.clock.fastForward(61_000);
    await expect.poll(async () => (await counts()).metadataReads).toBe(before.metadataReads + 2);
    expect((await counts()).textReads).toBe(before.textReads);
    await expect(page.locator(".message")).toHaveCount(messagesBefore);

    // The clone changes on disk (like a background git pull); the page picks it up by itself.
    await page.evaluate(() => {
      const clone = (
        window as unknown as { fakeClone: { write: (p: string, c: string, m: number) => void } }
      ).fakeClone;
      clone.write(
        "inbox/2026-10/2026-10-08T0905-bob-agent-api-01.md",
        [
          "---",
          "id: 2026-10-08T0905-bob-agent-api-01",
          "from: bob-agent",
          "to: all",
          "topic: api",
          "type: info",
          "reply_to:",
          "refs:",
          "needs: none",
          "due:",
          "---",
          "A message that arrived on disk.",
        ].join("\n"),
        Date.now(),
      );
    });
    await page.clock.fastForward(61_000);
    await expect(page.getByText("A message that arrived on disk.")).toBeVisible();
    await expect(indicator.locator(".last-changed")).toHaveText(
      /^Last change seen (just now|1 minute ago)$/,
    );
    expect(requests).toEqual([]);
  });
}

test("a browser without a folder picker gets an explanation instead of a broken button", async ({
  page,
}) => {
  await installFakeFolder(page, { picker: "missing" });
  await page.goto("/");
  await expect(page.getByText(/needs a browser that can open folders/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Open local folder/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Open another repository" }).click();
  await page.getByRole("button", { name: "Open offline demo" }).click();
  await expect(page.getByRole("button", { name: "Local folder", exact: true })).toHaveCount(0);
});

test("cancelling the picker, choosing a non-clone folder and revoked permission have clear states", async ({
  page,
}) => {
  await installFakeFolder(page, { picker: "cancels" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open local folder (experimental)" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "No folder selected, or the browser does not allow this folder.",
  );
  await expect(page.getByRole("heading", { name: "Agent collaboration viewer" })).toBeVisible();

  const other = await page.context().newPage();
  await installFakeFolder(other, { picker: "not-a-clone" });
  await other.goto("/");
  await other.getByRole("button", { name: "Open local folder (experimental)" }).click();
  await expect(other.getByRole("alert")).toContainText("not a collaboration clone");

  const revoked = await page.context().newPage();
  await revoked.clock.install({ time: new Date() });
  await installFakeFolder(revoked, { picker: "works" });
  await revoked.goto("/");
  await revoked.getByRole("button", { name: "Open local folder (experimental)" }).click();
  await expect(revoked.getByText("The first message from the local clone.")).toBeVisible();
  await revoked.evaluate(() => {
    (
      window as unknown as { fakeClone: { state: { permission: string } } }
    ).fakeClone.state.permission = "prompt";
  });
  await revoked.clock.fastForward(61_000);
  await expect(revoked.getByRole("alert")).toContainText(
    "Local folder permission needs to be granted again. Choose the folder again from the toolbar.",
  );
  // The messages stay on screen, and choosing the folder again recovers.
  await expect(revoked.getByText("The first message from the local clone.")).toBeVisible();
  await revoked.evaluate(() => {
    (
      window as unknown as { fakeClone: { state: { permission: string } } }
    ).fakeClone.state.permission = "granted";
  });
  await revoked.getByRole("button", { name: "Local folder", exact: true }).click();
  await expect(revoked.getByRole("alert")).toHaveCount(0);
  await expect(revoked.getByText("The first message from the local clone.")).toBeVisible();
});

const catalogsByLocale = { en, ja, "zh-TW": zhTW } as const;

/**
 * Nothing may be clipped or pushed outside the viewport. Every comma-separated selector must match
 * at least one element, so a renamed class cannot turn the check into a silent no-op. Block-level
 * elements are measured by scroll width, inline ones by their own box against the viewport; a
 * deliberately scrolling row (overflow-x) may extend past it.
 */
async function expectNoClipping(page: Page, selectors: string) {
  for (const selector of selectors.split(",").map((part) => part.trim())) {
    const result = await page.$$eval(selector, (elements) => ({
      count: elements.length,
      clipped: elements
        .filter((element) => {
          const box = element.getBoundingClientRect();
          const inline = getComputedStyle(element).display === "inline";
          // A chip row that scrolls sideways on purpose may extend past the viewport.
          let scroller = element.parentElement;
          while (
            scroller !== null &&
            !["auto", "scroll"].includes(getComputedStyle(scroller).overflowX)
          ) {
            scroller = scroller.parentElement;
          }
          return (
            (!inline && element.scrollWidth > element.clientWidth + 1) ||
            (scroller === null && (box.right > window.innerWidth + 1 || box.left < -1))
          );
        })
        .map((element) => `${element.tagName} ${element.textContent.slice(0, 40)}`),
    }));
    expect(result.count, `"${selector}" matched nothing`).toBeGreaterThan(0);
    expect(result.clipped, `clipped elements for "${selector}"`).toEqual([]);
  }
}

for (const code of LOCALES) {
  const messages = catalogsByLocale[code];
  for (const view of [
    { label: "desktop", size: { width: 1280, height: 800 } },
    { label: "phone", size: { width: 390, height: 844 } },
  ] as const) {
    test(`the interface switches to ${LOCALE_NAMES[code]} and fits on ${view.label}`, async ({
      page,
    }) => {
      await page.setViewportSize(view.size);
      await page.goto("/");
      // Switch away first, then to the language under test, so English is proven too.
      const other = code === "ja" ? "zh-TW" : "ja";
      await page.getByLabel(en["language.label"]).selectOption(other);
      await expect(page.locator("html")).toHaveAttribute("lang", other);
      await page.getByLabel(catalogsByLocale[other]["language.label"]).selectOption(code);
      await expect(page.locator("html")).toHaveAttribute("lang", code);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(messages["app.title"]);
      await expect(
        page.getByRole("button", { name: messages["welcome.openLiveDemo"] }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: messages["welcome.openLocal"] })).toBeVisible();
      await expectNoClipping(page, ".settings button, .settings h1");
      await saveScreenshot(page, `i18n-welcome-${code}-${view.label}.png`);

      // The choice survives a reload and reaches the viewer.
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", code);
      await page.getByRole("button", { name: messages["welcome.openAnother"] }).click();
      await expectNoClipping(
        page,
        ".settings button, .settings .field > span, .settings legend, .settings .note",
      );
      await saveScreenshot(page, `i18n-settings-${code}-${view.label}.png`);
      await page.getByRole("button", { name: messages["settings.openOffline"] }).click();
      const toolbar = page.locator(".bar-actions");
      await expect(toolbar.getByRole("button", { name: messages["bar.refresh"] })).toBeVisible();
      await expect(toolbar.getByRole("button", { name: messages["bar.settings"] })).toBeVisible();
      await expect(toolbar.getByLabel(messages["bar.viewingAs"])).toBeVisible();
      await expect(page.getByRole("button", { name: messages["nav.questions"] })).toBeVisible();
      // On the phone this is the topics list with its counters, before any topic is chosen.
      await expectNoClipping(
        page,
        ".bar-actions button, .bar-actions select, .topics button, .topics-pane h2",
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await saveScreenshot(page, `i18n-topics-${code}-${view.label}.png`);
      if (view.size.width < 721) {
        await page.getByRole("button", { name: messages["nav.all"] }).click();
        await expect(page.getByRole("button", { name: messages["nav.back"] })).toBeVisible();
        await expectNoClipping(page, ".back-to-topics, .conversation h2");
      }
      await expect(page.getByRole("link", { name: messages["nav.jumpLatest"] })).toBeAttached();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await saveScreenshot(page, `i18n-viewer-${code}-${view.label}.png`);

      // Chat rows, receipts, the profile panel and the Questions view in this language.
      await expectNoClipping(page, ".message .meta, .receipts, .group-header");
      if (view.size.width < 721) {
        await page.getByRole("button", { name: messages["nav.back"] }).click();
      }
      await page.getByRole("button", { name: messages["nav.questions"] }).click();
      await expectNoClipping(page, ".question-link, .question-group h3, .conversation h2");
      await page.getByRole("button", { name: messages["bar.profile"] }).click();
      await expect(page.getByRole("heading", { name: messages["profile.title"] })).toBeVisible();
      await expectNoClipping(
        page,
        ".profile button, .profile legend, .profile .note, .profile-name span",
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await saveScreenshot(page, `i18n-profile-${code}-${view.label}.png`);

      // The Files view and an attachment card.
      if (view.size.width < 721) {
        await page.getByRole("button", { name: messages["nav.back"] }).click();
      }
      await page.getByRole("button", { name: messages["nav.files"], exact: true }).click();
      const card = page.locator(".files .file-card").first();
      await card.locator("summary").click();
      await expect(card.locator(".file-body")).toBeVisible();
      await expectNoClipping(page, ".files .file-card, .file-body, .file-badge, .conversation h2");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await saveScreenshot(page, `i18n-files-${code}-${view.label}.png`);
    });

    test(`errors and notices fit in ${LOCALE_NAMES[code]} on ${view.label}`, async ({ page }) => {
      await page.setViewportSize(view.size);
      await page.addInitScript((locale) => {
        localStorage.setItem("agent-collab-viewer.locale", locale);
      }, code);
      await installFakeFolder(page, { picker: "cancels" });
      await page.route("**/demo-snapshot.json", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            schemaVersion: 1,
            generatedAt: "2026-11-03T08:00:00.000Z",
            revision: "snapshot-tree",
            files: [
              { path: ".agent-collab", text: "collab-protocol: 1\nparticipants: alice-agent\n" },
              {
                path: "inbox/2026-11-03T0900-alice-agent-api-01.md",
                text: cloneMessage(
                  "2026-11-03T0900-alice-agent-api-01",
                  "alice-agent",
                  "From the snapshot.",
                ),
              },
            ],
          }),
        }),
      );
      await page.route("https://api.github.com/**", (route) =>
        route.fulfill({
          status: 403,
          contentType: "application/json",
          headers: {
            "access-control-allow-origin": "*",
            "access-control-expose-headers":
              "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
            "retry-after": "3600",
          },
          body: JSON.stringify({ message: "Synthetic rate limit" }),
        }),
      );
      await page.goto("/");
      await page.getByRole("button", { name: messages["welcome.openLocal"] }).click();
      await expect(page.getByRole("alert")).toHaveText(messages["local.noFolder"]);
      await expectNoClipping(page, '[role="alert"]');
      await saveScreenshot(page, `i18n-alert-${code}-${view.label}.png`);

      await page.getByRole("button", { name: messages["welcome.openLiveDemo"] }).click();
      await page.getByRole("button", { name: messages["bar.checkLive"] }).click();
      await expect(page.locator(".notice")).toContainText(messages["live.hitLimit"]);
      await expectNoClipping(page, ".notice, .bar-actions button");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await saveScreenshot(page, `i18n-notice-${code}-${view.label}.png`);
    });
  }
}

test("the browser language picks the interface language, and an unwritable store does not break switching", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "ja-JP" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage is unavailable", "SecurityError");
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(ja["app.title"]);
  await page.getByLabel(ja["language.label"]).selectOption("zh-TW");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(zhTW["app.title"]);
  expect(errors).toEqual([]);
  await context.close();
});

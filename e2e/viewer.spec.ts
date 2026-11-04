import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import { en, LOCALE_NAMES, LOCALES } from "../src/i18n/catalog";
import { ja } from "../src/i18n/ja";
import { zhTW } from "../src/i18n/zh-TW";
import { formatDateTime, translate } from "../src/i18n/translate";

const catalogsByLocale = { en, ja, "zh-TW": zhTW } as const;

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
      "0903",
      "alice-agent",
      "api",
      6,
      "info",
      "Friendly nudge about the schema.",
      "bob-agent",
      open.id,
    ),
    makeMessage(
      "2026-10-08",
      "0904",
      "alice-agent",
      "api",
      7,
      "info",
      "Second nudge about the schema.",
      "bob-agent",
      open.id,
    ),
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
      "all",
      concluded.id,
    ),
  ];
}

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The viewer shows at most this many CSV rows (CSV_PREVIEW_ROWS in src/ui/Attachments.tsx). */
const CSV_ROW_CAP = 100;

/**
 * A table with 40 columns of long-ish values, wider than any viewport the viewer supports, and
 * more rows than the preview shows, so it also scrolls vertically inside its box.
 */
function wideCsv(): string {
  const columns = Array.from({ length: 40 }, (_, index) => `column_${String(index + 1)}`);
  const row = (name: string) => columns.map((column) => `${name}-${column}-value`).join(",");
  const rows = Array.from({ length: CSV_ROW_CAP + 20 }, (_, index) => row(`r${String(index)}`));
  return [columns.join(","), ...rows].join("\n") + "\n";
}

const TOPIC_FILES: Readonly<Record<string, { sha: string; body: string | Buffer }>> = {
  "fields-v1.md": {
    sha: "topic-md",
    body: "# Field list\n\n- **id** is required\n- `note` is optional\n\n<script>window.pwned = true</script>\n",
  },
  "results.csv": { sha: "topic-csv", body: 'name,score\nalice,"9, great"\nbob,7\n' },
  "wide.csv": { sha: "topic-wide-csv", body: wideCsv() },
  "diagram.png": { sha: "topic-png", body: Buffer.from(PNG_BASE64, "base64") },
  "archive.bin": { sha: "topic-bin", body: "opaque bytes" },
};

/** Two topics, one of them named by a single unbreakable word (no hyphen to break at) far wider than a phone screen. */
function longTopicThread(): MessageFixture[] {
  return [
    makeMessage("2026-10-08", "0900", "alice-agent", "api", 1, "info", "Short topic message."),
    makeMessage(
      "2026-10-08",
      "0910",
      "alice-agent",
      "anextraordinarilylongtopicnamewithoutanybreakopportunityatall0123456789abcdefghij",
      1,
      "info",
      "Long topic message.",
    ),
  ];
}

/**
 * 60 messages in 20 days (3 a day, flat inbox), more than one page of 50. The last one replies to
 * the very first, which lies outside the newest page.
 */
function historyThread(): MessageFixture[] {
  const first = makeMessage("2026-09-01", "0900", "alice-agent", "api", 1, "question", "Opening.");
  const result = [first];
  for (let index = 1; index < 60; index += 1) {
    const day = `2026-09-${String(1 + Math.floor(index / 3)).padStart(2, "0")}`;
    const time = `09${String(index % 3).padStart(2, "0")}`;
    const reply = index === 59;
    result.push(
      makeMessage(
        day,
        time,
        "bob-agent",
        "api",
        index + 1,
        reply ? "answer" : "info",
        reply ? "Late answer to the opening question." : `History message ${String(index)}.`,
        "alice-agent",
        reply ? first.id : "",
      ),
    );
  }
  return result;
}

/** 30 messages each in July, August and September, in month folders; the last replies to the first. */
function historyMonthlyThread(): MessageFixture[] {
  const first = makeMessage("2026-07-01", "0900", "alice-agent", "api", 1, "question", "Opening.");
  const result = [first];
  for (let index = 1; index < 90; index += 1) {
    const month = ["07", "08", "09"][Math.floor(index / 30)] ?? "09";
    const day = `2026-${month}-${String(1 + Math.floor((index % 30) / 3)).padStart(2, "0")}`;
    const reply = index === 89;
    result.push(
      makeMessage(
        day,
        `09${String(index % 3).padStart(2, "0")}`,
        "bob-agent",
        "api",
        index + 1,
        reply ? "answer" : "info",
        reply ? "Late answer to the opening question." : `History message ${String(index)}.`,
        "alice-agent",
        reply ? first.id : "",
      ),
    );
  }
  return result;
}

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
    "topics/api/fields-v1.md, topics/api/results.csv, topics/api/wide.csv, topics/api/diagram.png, topics/api/archive.bin, https://docs.example.com/guide, topics/api/other.md, topics/api/an-extraordinarily-long-file-name-that-keeps-going-and-going-for-the-phone-viewport-check-0123456789.md, https://a-very-long-host-name-for-the-wrapping-check-at-phone-width.example.invalid/path, 2026-10-08T0910-alice-agent-ops-01",
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
  mode:
    | "long"
    | "questions"
    | "attachments"
    | "empty"
    | "error"
    | "long-topic"
    | "history"
    | "history-monthly",
) {
  const messages =
    mode === "long"
      ? longThread()
      : mode === "questions"
        ? questionThread()
        : mode === "attachments"
          ? attachmentThread()
          : mode === "long-topic"
            ? longTopicThread()
            : mode === "history"
              ? historyThread()
              : mode === "history-monthly"
                ? historyMonthlyThread()
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
  const apiRequests: string[] = [];
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

    apiRequests.push(path.slice(path.indexOf("/git/")));
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
      if (mode === "history-monthly") {
        await json(route, {
          truncated: false,
          tree: [
            treeEntry("2026-07", "month-2026-07", "tree"),
            treeEntry("2026-08", "month-2026-08", "tree"),
            treeEntry("2026-09", "month-2026-09", "tree"),
          ],
        });
        return;
      }
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

    const month = /\/git\/trees\/month-(2026-\d{2})$/.exec(path)?.[1];
    if (month !== undefined) {
      const entries = messages
        .filter((message) => message.id.startsWith(month))
        .map((message) => {
          const sha = `message-m-${message.id}`;
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
      apiRequests: () => apiRequests,
    },
  );
}

async function openViewer(
  page: Page,
  mode:
    | "long"
    | "questions"
    | "attachments"
    | "empty"
    | "error"
    | "long-topic"
    | "history"
    | "history-monthly",
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

/**
 * Presses a toolbar control: directly where the toolbar shows icons, through the "More" menu where
 * the narrow layout puts it.
 */
async function toolbarAction(page: Page, name: string) {
  const bar = page.locator(".bar-actions");
  const direct = bar.getByRole("button", { name, exact: true });
  if ((await direct.count()) > 0 && (await direct.first().isVisible())) {
    await direct.first().click();
    return;
  }
  await bar.getByRole("button", { name: /^(More|その他|更多)$/ }).click();
  await page
    .getByRole("menuitem", { name, exact: true })
    .or(page.getByRole("menuitemcheckbox", { name, exact: true }))
    .click();
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

  await toolbarAction(page, "Use Paper theme");
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
  await expect(page.locator(".sr-only[role=status]")).toHaveText(
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

  await toolbarAction(page, "Use Night Owl theme");
  await saveScreenshot(page, "phone-night-owl.png");
  await toolbarAction(page, "Use Paper theme");

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
  await expect(page.getByRole("heading", { name: "Collab Viewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open live demo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open saved repository" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open another repository" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use Paper theme" })).toBeVisible();
  await saveScreenshot(page, "welcome-night-owl.png");
  await toolbarAction(page, "Use Paper theme");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  await saveScreenshot(page, "welcome-paper.png");
  await toolbarAction(page, "Use Night Owl theme");

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
    label: document.activeElement?.getAttribute("aria-label"),
    outlineStyle: getComputedStyle(document.activeElement as Element).outlineStyle,
    outlineWidth: getComputedStyle(document.activeElement as Element).outlineWidth,
  }));
  expect(focused.label).toBe("Refresh");
  expect(focused.outlineStyle).toBe("solid");
  expect(focused.outlineWidth).toBe("3px");

  // Viewing as, Profile & colors, Local folder, language, theme, Settings, Questions, Files, All, then the first topic.
  // The signed-in banner's Remove token button is one more stop before the topics.
  for (let tab = 0; tab < 11; tab += 1) await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "#release" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveCSS("scroll-behavior", "auto");
  const timestamp = page.locator("time").first();
  // A message time is not a tab stop; its full timestamp shows on hover.
  await expect(page.locator("time[tabindex]")).toHaveCount(0);
  await timestamp.hover();
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

/** The demo's snapshot is served, and every API request is answered with a rate limit. */
async function stubLimitedDemo(page: Page, text: string): Promise<string[]> {
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
          text,
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
  return requests;
}

test("a live-demo rate limit keeps the snapshot visible", async ({ page }) => {
  const requests = await stubLimitedDemo(
    page,
    "Snapshot remains available after an API rate limit.",
  );
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

  // The limit is a dead end no more: the notice offers a token, and the action opens Settings at
  // the token section with the demo repository filled in and the token field focused.
  await page.getByRole("button", { name: "Use a token for a higher limit" }).click();
  await expect(page.locator("#token-section")).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Repository", exact: true })).toHaveValue(
    "sympoies/agent-collab-demo",
  );
  const create = page.getByRole("link", { name: "Create a token on GitHub" });
  await expect(create).toHaveAttribute("rel", "noopener noreferrer");
  await expect(create).toHaveAttribute("target", "_blank");
  const target = new URL((await create.getAttribute("href")) ?? "");
  expect(`${target.origin}${target.pathname}`).toBe(
    "https://github.com/settings/personal-access-tokens/new",
  );
  expect(Object.fromEntries(target.searchParams)).toMatchObject({
    expires_in: "30",
    target_name: "sympoies",
  });
  expect(target.searchParams.has("contents")).toBe(false);
  await expectNoClipping(page, ".token-help, .token-help p, .token-help a");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open live demo" }).click();
  await expect(page.getByText("Snapshot remains available after an API rate limit.")).toBeVisible();
  expect(requests).toHaveLength(requestsAfterLimit);
});

for (const code of LOCALES) {
  const messages = catalogsByLocale[code];
  for (const view of [
    { label: "desktop", size: { width: 1280, height: 800 } },
    { label: "phone", size: { width: 390, height: 844 } },
  ] as const) {
    test(`the token action, token section and signed-in banner read well in ${LOCALE_NAMES[code]} on ${view.label}`, async ({
      page,
    }) => {
      await page.setViewportSize(view.size);
      await page.addInitScript((locale) => {
        localStorage.setItem("agent-collab-viewer.locale", locale);
      }, code);
      await stubLimitedDemo(page, "Snapshot remains available after an API rate limit.");
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: messages["welcome.demoHeading"] }),
      ).toBeVisible();
      await expect(page.getByText(messages["welcome.limits"])).toBeVisible();
      await expectNoClipping(page, ".settings h2, .settings .note, .settings button");
      await page.getByRole("button", { name: messages["welcome.openLiveDemo"] }).click();
      await page.getByRole("button", { name: messages["bar.checkLive"], exact: true }).click();
      const action = page.getByRole("button", { name: messages["notice.useToken"] });
      await expect(action).toBeVisible();
      await expectNoClipping(page, ".notice, .notice-action, .notice-action button");
      await saveScreenshot(page, `token-action-${code}-${view.label}.png`);
      await action.click();
      await expect(page.locator("#token-section")).toBeVisible();
      await expect(page.locator('input[type="password"]')).toBeFocused();
      await expect(page.getByText(messages["settings.tokenWhy"])).toBeVisible();
      await expectNoClipping(page, ".token-help, .token-help p, .token-help a");
      await saveScreenshot(page, `token-section-${code}-${view.label}.png`);
      // The prefilled link's name and description follow the language; the owner is the demo's.
      const link = page.getByRole("link", { name: messages["settings.tokenCreate"] });
      const target = new URL((await link.getAttribute("href")) ?? "");
      expect(target.searchParams.get("name")).toBe(messages["settings.tokenName"]);
      expect(target.searchParams.get("description")).toBe(messages["settings.tokenDescription"]);

      // Sign in with a token for a fixture repository and read the banner in this language.
      await installApiStub(page, "attachments");
      await page
        .getByRole("textbox", { name: messages["settings.repository"], exact: true })
        .fill("alice-agent/fixture-repo");
      await page.getByLabel(messages["settings.branch"]).fill("main");
      await page.getByLabel(messages["settings.myNames"]).fill("alice-agent");
      await page.locator('input[type="password"]').fill("fake-token");
      await page.getByRole("button", { name: messages["settings.saveOpen"] }).click();
      const banner = page.locator(".signed-in");
      await expect(banner).toContainText(messages["signedIn.banner"]);
      await expect(banner.getByRole("button", { name: messages["signedIn.remove"] })).toBeVisible();
      await expectNoClipping(page, ".signed-in, .signed-in button");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await saveScreenshot(page, `signed-in-${code}-${view.label}.png`);
    });
  }
}

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

    await expect(page.locator(".bar-actions button").first()).toHaveAttribute(
      "aria-label",
      "Refresh",
    );

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

    await toolbarAction(page, "Profile & colors");
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

for (const code of ["ja", "zh-TW"] as const) {
  test(`reminders are labeled and fit on a phone in ${LOCALE_NAMES[code]}`, async ({ page }) => {
    const messages = catalogsByLocale[code];
    await page.setViewportSize({ width: 390, height: 844 });
    const assertRequests = await openViewer(page, "questions");
    await page.getByRole("button", { name: /^(More|その他|更多)$/ }).click();
    await page.getByRole("menuitemradio", { name: LOCALE_NAMES[code], exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", code);
    await page.getByRole("button", { name: /^#api/ }).click();
    const question = page.locator("#msg-2026-10-08T0900-alice-agent-api-01");
    await expect(question.locator(".reminder-count")).toHaveText(
      messages["receipt.reminders"].replace("{count}", "2").replace("{time}", "09:04"),
    );
    const nudge = page.locator(".message", { hasText: "Friendly nudge about the schema." });
    await expect(nudge.locator(".badge")).toHaveText(messages["type.reminder"]);
    await page.getByRole("button", { name: messages["nav.back"] }).click();
    await page.getByRole("button", { name: new RegExp(`^${messages["nav.questions"]}`) }).click();
    const open = page.getByRole("region", { name: messages["questions.open"] });
    await expect(open.locator(".reminder-count")).toHaveText(
      messages["receipt.reminders"].replace("{count}", "2").replace("{time}", "2026-10-08 09:04"),
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    assertRequests();
  });
}

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
    await expect(question.locator(".reminder-count")).toHaveText("2 reminders, last 09:04");
    const nudge = page.locator(".message", { hasText: "Friendly nudge about the schema." });
    await expect(nudge.locator(".badge")).toHaveText("reminder");
    await expect(nudge.locator(".conclusion")).toHaveCount(0);
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
    await expect(open.locator(".reminder-count")).toHaveText("2 reminders, last 2026-10-08 09:04");
    await expect(open.locator(".conclusion-text")).toHaveCount(0);
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
  test(`a signed-in viewer shows the higher-limit banner and removes the token on ${identity.label} in ${identity.theme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: identity.scheme });
    await page.setViewportSize(identity.viewport);
    const assertRequests = await openViewer(page, "attachments");
    const banner = page.locator(".signed-in");
    await expect(banner).toContainText("Signed in with a token: higher limit.");
    await expectNoClipping(page, ".signed-in, .signed-in button");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    await saveScreenshot(page, `signed-in-${identity.label}-${identity.theme}.png`);
    // The token never reaches the page text.
    expect(await page.locator("body").innerText()).not.toContain("fake-token");
    await banner.getByRole("button", { name: "Remove token" }).click();
    await expect(page.getByRole("heading", { name: "Try the demo" })).toBeVisible();
    await expect(page.getByText("60 anonymous requests per hour")).toBeVisible();
    await expectNoClipping(page, ".settings button, .settings h2, .settings .note");
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
    await expect(first.locator(".file-card")).toHaveCount(7);
    await expect(first.locator(".file-badge")).toHaveText([
      "MD",
      "CSV",
      "CSV",
      "IMG",
      "FILE",
      "MD",
      "MD",
    ]);
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

    // A table wider than the screen scrolls inside its card; the page and the card do not grow.
    // The case that is running is the one the title says.
    expect(await page.evaluate(() => window.innerWidth)).toBe(identity.viewport.width);
    expect(await page.evaluate(() => window.matchMedia("(max-width: 720px)").matches)).toBe(phone);
    await card("wide.csv").locator("summary").click();
    const wide = card("wide.csv");
    await expect(wide.locator("th")).toHaveCount(40);
    const fit = await wide.evaluate((node, cap) => {
      const box = node.querySelector<HTMLElement>(".csv-preview");
      const card = node.getBoundingClientRect();
      const inner = box?.getBoundingClientRect();
      const cells = [...node.querySelectorAll("th, td")].map((cell) => {
        const style = getComputedStyle(cell);
        const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        // A cell that wraps per character would be several lines tall.
        return {
          oneLine: cell.getBoundingClientRect().height <= line + padding + 4,
          noWrap: style.whiteSpace === "nowrap",
        };
      });
      return {
        scrollsAcross: (box?.scrollWidth ?? 0) > (box?.clientWidth ?? 0),
        scrollsDown: (box?.scrollHeight ?? 0) > (box?.clientHeight ?? 0),
        insideCard: (inner?.right ?? Infinity) <= card.right + 0.5,
        cardInsideViewport: card.right <= window.innerWidth + 0.5,
        rows: node.querySelectorAll("tbody tr").length === cap,
        everyCellOneLine: cells.every((cell) => cell.oneLine && cell.noWrap),
        cells: cells.length,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    }, CSV_ROW_CAP);
    expect(fit.cells).toBeGreaterThan(40);
    expect(fit.pageOverflow).toBeLessThanOrEqual(0);
    expect({ ...fit, cells: 0, pageOverflow: 0 }).toEqual({
      scrollsAcross: true,
      scrollsDown: true,
      insideCard: true,
      cardInsideViewport: true,
      rows: true,
      everyCellOneLine: true,
      cells: 0,
      pageOverflow: 0,
    });
    await saveScreenshot(page, `wide-csv-${identity.label}-${identity.theme}.png`);

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
    await expect(page.locator(".files .file-name")).toHaveCount(7);
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
  options: {
    picker: "works" | "cancels" | "missing" | "not-a-clone";
    layout?: "topic";
  },
) {
  await page.addInitScript(
    ({ mode, marker, first, layout }) => {
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
      write(
        layout === "topic"
          ? "topics/api/inbox/2026-10/2026-10-08T0900-alice-agent-api-01.md"
          : "inbox/2026-10/2026-10-08T0900-alice-agent-api-01.md",
        first,
        Date.now() - 10 * 60_000,
      );
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
      layout: options.layout,
      marker: options.layout === "topic" ? `${CLONE_MARKER}inbox-layout: topic\n` : CLONE_MARKER,
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
      /^Last change seen (just now|1 minute ago|\d+ minutes ago) · alice-agent$/,
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
      /^Last change seen (just now|1 minute ago) · bob-agent$/,
    );
    expect(requests).toEqual([]);
  });
}

// The production CSP has no `style-src`, so an inline style attribute is a violation in browsers
// that report them. The "@csp" tests run in Chromium and in WebKit (the two projects of
// playwright.config.ts) and must see no style attribute in the DOM on the main screens. WebKit
// additionally reports one `style-src-attr` violation for every `<select>` it creates (its
// built-in popup button carries an inline style; a bare `<select>` on a page with this CSP does
// the same), so there the violations must match the number of selects exactly: anything more is
// an inline style of ours. A missing browser fails the run; it is never skipped.
test("no inline style attribute and no CSP violation of ours @csp", async ({
  page,
  browserName,
}, testInfo) => {
  expect(browserName, "the project runs its own engine").toBe(testInfo.project.name);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    const log: string[] = [];
    const state = { violations: log, selects: 0 };
    Object.assign(window, { cspProbe: state });
    document.addEventListener("securitypolicyviolation", (event) => {
      log.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
    // Count every select that enters the document, including those inside added subtrees.
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          state.selects +=
            (node.matches("select") ? 1 : 0) + node.querySelectorAll("select").length;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const probe = () =>
    page.evaluate(
      () => (window as unknown as { cspProbe: { violations: string[]; selects: number } }).cspProbe,
    );
  const inlineStyles = () => page.locator("[style]").count();
  const seen: string[] = [];
  const expectClean = async (step: string) => {
    const { violations, selects } = await probe();
    const unexpected = browserName === "webkit" ? violations.length - selects : violations.length;
    expect({
      step,
      styles: await inlineStyles(),
      unexpected,
      kinds: new Set(violations),
    }).toEqual({
      step,
      styles: 0,
      unexpected: 0,
      kinds:
        browserName === "webkit" && selects > 0 ? new Set(["style-src-attr inline"]) : new Set(),
    });
    seen.push(step);
  };

  const assertRequests = await installApiStub(page, "attachments");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open another repository" })).toBeVisible();
  await expectClean("welcome");
  await page.getByRole("button", { name: "Open another repository" }).click();
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  await expectClean("settings");
  await page
    .getByRole("textbox", { name: "Repository", exact: true })
    .fill("alice-agent/fixture-repo");
  await page.getByLabel("Branch").fill("main");
  await page.getByLabel("My names").fill("alice-agent");
  await page.getByLabel("Access token").fill("fake-token");
  await page.getByRole("button", { name: "Save and open" }).click();
  await page.getByRole("button", { name: /^#api/ }).click();
  const first = page.locator("#msg-2026-10-08T0900-alice-agent-api-01");
  await first.locator(".file-card", { hasText: "wide.csv" }).locator("summary").click();
  await expect(first.locator("th")).toHaveCount(40);
  await first.locator(".file-card", { hasText: "diagram.png" }).locator("summary").click();
  await expect(first.locator("img")).toBeVisible();
  await expect(page.locator(".group").first()).toHaveAttribute("data-slot", /^[0-7]$/);
  await expectClean("chat with previews");
  await page.getByRole("button", { name: /^Questions/ }).click();
  await expect(page.locator("#conversation-heading")).toHaveText("Questions");
  await expectClean("questions with receipts");
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.locator("#conversation-heading")).toContainText("Files");
  await expectClean("files");
  // The overflow menu of the phone toolbar, open.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expectClean("overflow menu");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "Profile & colors" })).toBeVisible();
  await page.getByRole("button", { name: "Profile & colors" }).click();
  await expect(page.locator(".profile .swatch").first()).toBeVisible();
  await expectClean("profile");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  await expectClean("settings again");
  expect(seen).toEqual([
    "welcome",
    "settings",
    "chat with previews",
    "questions with receipts",
    "files",
    "overflow menu",
    "profile",
    "settings again",
  ]);
  assertRequests();
});

test("the favicon is requested under the base path and does not 404", async ({ page }) => {
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open another repository" })).toBeVisible();
  const link = page.locator('link[rel="icon"]');
  await expect(link).toHaveAttribute("type", "image/svg+xml");
  const href = await link.getAttribute("href");
  expect(href).toBe("/favicon.svg");
  // Headless browsers do not always fetch the icon by themselves; fetch what the page declares.
  const icon = await page.request.get(new URL(href ?? "", page.url()).toString());
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  expect(await icon.text()).toContain("<svg");
  expect(failures.filter((failure) => failure.includes("favicon"))).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

// The colors people get were not changed by moving them from inline styles to data-slot rules:
// the resolved color of every slot, in each theme, is the pre-change palette.
const PALETTES = {
  paper: ["#af4e1c", "#2d6c3f", "#6d4aa8", "#2457a7", "#0a7685", "#a43c2e", "#855b00", "#596b79"],
  "night-owl": [
    "#f78c6c",
    "#addb67",
    "#c792ea",
    "#82aaff",
    "#7fdbca",
    "#ef5350",
    "#ffcb8b",
    "#8ba1b8",
  ],
} as const;

function rgbOf(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)})`;
}

for (const theme of ["paper", "night-owl"] as const) {
  test(`every person slot resolves to its palette color in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme === "paper" ? "light" : "dark" });
    const assertRequests = await openViewer(page, "attachments");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: "Profile & colors" }).click();
    const person = page.locator(".profile-person").first();
    const swatches = person.locator(".swatch");
    await expect(swatches).toHaveCount(PALETTES[theme].length);
    const resolved = await swatches.evaluateAll((nodes) =>
      nodes.map((node) => ({
        slot: node.getAttribute("data-slot"),
        color: getComputedStyle(node).backgroundColor,
      })),
    );
    expect(resolved).toEqual(
      PALETTES[theme].map((hex, slot) => ({ slot: String(slot), color: rgbOf(hex) })),
    );
    // Choosing a slot colors that person's messages with it (a color override on data-slot).
    await swatches.nth(3).locator("input").check();
    const group = page.locator(".group").first();
    await expect(group).toHaveAttribute("data-slot", "3");
    await expect(group.locator(".avatar")).toHaveCSS("background-color", rgbOf(PALETTES[theme][3]));
    assertRequests();
  });
}

for (const identity of identityCases) {
  test(`every topic and its counter are visible on ${identity.label} in ${identity.theme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: identity.scheme });
    await page.setViewportSize(identity.viewport);
    const assertRequests = await openViewer(page, "attachments");
    await expect(page.locator("html")).toHaveAttribute("data-theme", identity.theme);
    const chips = page.locator(".topics button");
    await expect(page.getByRole("button", { name: /^#ops/ })).toBeVisible();
    expect(await chips.count()).toBeGreaterThan(1);
    // Nothing is cut at the screen edge or hidden in a scroller, and the counters are readable.
    const boxes = await chips.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        const count = node.querySelector(".count")?.getBoundingClientRect();
        return {
          inside: box.left >= 0 && box.right <= window.innerWidth + 0.5,
          counter:
            count === undefined || (count.right <= window.innerWidth + 0.5 && count.width > 0),
        };
      }),
    );
    expect(await page.locator(".topics .count").count()).toBeGreaterThan(1);
    expect(boxes.every((box) => box.inside && box.counter)).toBe(true);
    const scroller = await page
      .locator(".topics")
      .evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(scroller).toBeLessThanOrEqual(1);
    await saveScreenshot(page, `topics-${identity.label}-${identity.theme}.png`);
    assertRequests();
  });
}

for (const code of LOCALES) {
  test(`a very long topic name stays inside its button on a phone in ${LOCALE_NAMES[code]}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const assertRequests = await openViewer(page, "long-topic");
    if (code !== "en") {
      await page.getByRole("button", { name: /^(More|その他|更多)$/ }).click();
      await page.getByRole("menuitemradio", { name: LOCALE_NAMES[code], exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", code);
    }
    const long = page.locator(".topics button", { hasText: "anextraordinarilylongtopic" });
    await expect(long).toBeVisible();
    const fit = await page.locator(".topics button").evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        const count = node.querySelector(".count")?.getBoundingClientRect();
        return {
          insideScreen: box.left >= 0 && box.right <= window.innerWidth + 0.5,
          noInnerOverflow: node.scrollWidth <= node.clientWidth + 1,
          // Buttons without a counter (Files, All) pass; the topics' counters stay inside.
          counterInside:
            count === undefined ||
            (count.width > 0 && count.left >= box.left - 0.5 && count.right <= box.right + 0.5),
        };
      }),
    );
    expect(fit.length).toBeGreaterThan(2);
    expect(await page.locator(".topics .count").count()).toBeGreaterThan(2);
    expect(fit.every((entry) => entry.insideScreen)).toBe(true);
    expect(fit.every((entry) => entry.noInnerOverflow)).toBe(true);
    expect(fit.every((entry) => entry.counterInside)).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    await saveScreenshot(page, `long-topic-${code}.png`);
    assertRequests();
  });
}

test("activating a message link with the keyboard moves focus to the message", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const assertRequests = await openViewer(page, "attachments");
  await page.getByRole("button", { name: /^#api/ }).click();
  const focused = () => page.evaluate(() => document.activeElement?.id ?? "");

  // Same topic: the target message takes the focus and keeps its highlight.
  const link = page
    .locator("#msg-2026-10-08T0905-bob-agent-api-02")
    .getByRole("link", { name: /^Message 2026-10-08 09:00/ });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect.poll(focused).toBe("msg-2026-10-08T0900-alice-agent-api-01");
  await expect(page.locator("#msg-2026-10-08T0900-alice-agent-api-01")).toHaveCSS(
    "outline-style",
    "solid",
  );

  // Another topic: the viewer switches topic and the focus lands on the message there.
  const other = page
    .locator("#msg-2026-10-08T0900-alice-agent-api-01")
    .getByRole("link", { name: /^Message 2026-10-08 09:10/ });
  await other.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#conversation-heading")).toHaveText("#ops");
  await expect.poll(focused).toBe("msg-2026-10-08T0910-alice-agent-ops-01");

  // The message itself is a focus target, not an extra tab stop.
  await expect(page.locator("time[tabindex], .message[tabindex='0']")).toHaveCount(0);
  assertRequests();
});

test("settings have one h1 and fields named without their hints, with errors connected", async ({
  page,
}) => {
  await installApiStub(page, "empty");
  await page.goto("/");
  await page.getByRole("button", { name: "Open another repository" }).click();
  await expect(page.locator("h1")).toHaveCount(1);
  // The hint is a description, not part of the field's name.
  const names = page.getByRole("textbox", { name: "My names", exact: true });
  await expect(names).toHaveAccessibleDescription(/default "Viewing as" person/);
  const repository = page.getByRole("textbox", { name: "Repository", exact: true });
  await expect(repository).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Save and open" }).click();
  await expect(repository).toHaveAttribute("aria-invalid", "true");
  const error = page.locator("[role=alert]", { hasText: /owner\/repository/i });
  await expect(error).toBeVisible();
  await expect(repository).toHaveAccessibleDescription(/owner\/repository/i);
  await expect(page.locator("h1")).toHaveCount(1);
});

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
  await expect(page.getByRole("heading", { name: "Collab Viewer" })).toBeVisible();

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

/**
 * Nothing may be clipped or pushed outside the viewport. Every comma-separated selector must match
 * at least one element, so a renamed class cannot turn the check into a silent no-op. Block-level
 * elements are measured by scroll width, inline ones by their own box against the viewport; a
 * deliberately scrolling row (overflow-x) may extend past it.
 */
async function expectNoClipping(page: Page, selectors: string) {
  for (const selector of selectors.split(",").map((part) => part.trim())) {
    // A screen that was just opened may not have rendered yet; a selector that never appears
    // still fails, with the message below.
    await expect(page.locator(selector).first(), `"${selector}" matched nothing`).toBeAttached();
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
      // The product name is the same English name in every language.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Collab Viewer");
      await expect(
        page.getByRole("button", { name: messages["welcome.openLiveDemo"] }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: messages["welcome.openLocal"] })).toBeVisible();
      await expectNoClipping(page, ".settings button, .settings h1, .settings h2, .settings .note");
      await saveScreenshot(page, `i18n-welcome-${code}-${view.label}.png`);

      // The choice survives a reload and reaches the viewer.
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", code);
      await page.getByRole("button", { name: messages["welcome.openAnother"] }).click();
      await expectNoClipping(
        page,
        ".settings button, .settings .field > label, .settings legend, .settings .note, .token-help, .token-help p, .token-help a",
      );
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Collab Viewer");
      await expect(page.locator("h1")).toHaveCount(1);
      await saveScreenshot(page, `i18n-settings-${code}-${view.label}.png`);
      await page.getByRole("button", { name: messages["settings.openOffline"] }).click();
      const toolbar = page.locator(".bar-actions");
      await expect(toolbar.getByRole("button", { name: messages["bar.refresh"] })).toBeVisible();
      // Wide screens show Settings as an icon; the phone puts it behind the More button.
      await expect(
        toolbar.getByRole("button", {
          name: view.size.width < 721 ? messages["bar.more"] : messages["bar.settings"],
        }),
      ).toBeVisible();
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
      await toolbarAction(page, messages["bar.profile"]);
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
  await expect(page.getByRole("button", { name: ja["welcome.openLiveDemo"] })).toBeVisible();
  await page.getByLabel(ja["language.label"]).selectOption("zh-TW");
  await expect(page.getByRole("button", { name: zhTW["welcome.openLiveDemo"] })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

function channel(rgb: string): [number, number, number] {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  if (match === null) throw new Error(`unsupported color: ${rgb}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance(rgb: string): number {
  const [r, g, b] = channel(rgb).map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The color a glyph is drawn on: the backgrounds from the page down to the element, translucent
 * ones (a hover tint) composited over what is beneath them.
 */
async function surfaceAndGlyph(locator: Locator): Promise<{ glyph: string; surface: string }> {
  return locator.evaluate((node) => {
    const layers: number[][] = [];
    for (let element: Element | null = node; element !== null; element = element.parentElement) {
      const match = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(
        getComputedStyle(element).backgroundColor,
      );
      if (match === null) continue;
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      if (alpha > 0) layers.push([Number(match[1]), Number(match[2]), Number(match[3]), alpha]);
      if (alpha === 1) break;
    }
    let base = [255, 255, 255];
    for (const [r = 0, g = 0, b = 0, a = 1] of layers.reverse()) {
      base = [r, g, b].map((value, index) => Math.round(value * a + (base[index] ?? 0) * (1 - a)));
    }
    return { glyph: getComputedStyle(node).color, surface: `rgb(${base.join(", ")})` };
  });
}

for (const view of [
  { label: "desktop", size: { width: 1280, height: 800 } },
  { label: "phone", size: { width: 390, height: 844 } },
] as const) {
  for (const theme of [
    { name: "night-owl", scheme: "dark" },
    { name: "paper", scheme: "light" },
  ] as const) {
    test(`toolbar glyphs keep 3:1 in every state, names are computed and the menu keyboard flow works on ${view.label} in ${theme.name}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme.scheme });
      await page.setViewportSize(view.size);
      const assertRequests = await openViewer(page, "attachments");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.name);
      const phone = view.size.width < 721;
      const bar = page.locator(".bar-actions");
      const checked: string[] = [];
      const expectReadable = async (locator: Locator, what: string) => {
        const { glyph, surface } = await surfaceAndGlyph(locator);
        expect(contrast(glyph, surface), `${what}: ${glyph} on ${surface}`).toBeGreaterThanOrEqual(
          3,
        );
        checked.push(what);
      };

      // Names: the computed accessible name of every control, and the tooltip of every icon button.
      const nameOf = en;
      await expect(page.getByRole("combobox", { name: nameOf["bar.viewingAs"] })).toBeVisible();
      if (!phone) {
        await expect(page.getByRole("combobox", { name: nameOf["language.label"] })).toBeVisible();
      }
      const iconNames = [
        nameOf["bar.refresh"],
        ...(phone
          ? [nameOf["bar.more"]]
          : [nameOf["bar.profile"], nameOf["bar.localFolder"], nameOf["bar.settings"]]),
      ];
      for (const name of iconNames) {
        const button = bar.getByRole("button", { name, exact: true });
        await expect(button).toHaveAccessibleName(name);
        await expect(button).toHaveAttribute("title", name);
        await expectReadable(button, `${name} at rest`);
        await button.hover();
        await expectReadable(button, `${name} hovered`);
      }
      // Focus-visible: reach the first icon button with the keyboard.
      await page.keyboard.press("Tab");
      const focused = page.locator(":focus-visible");
      await expect(focused).toHaveCount(1);
      await expectReadable(focused, "keyboard focus");
      // Disabled (Refresh while a refresh is running): the glyph is dimmed but stays measurable.
      const refresh = bar.getByRole("button", { name: nameOf["bar.refresh"], exact: true });
      await refresh.evaluate((node) => {
        (node as HTMLButtonElement).disabled = true;
      });
      await expectReadable(refresh, "Refresh disabled");
      await refresh.evaluate((node) => {
        (node as HTMLButtonElement).disabled = false;
      });
      if (!phone) await expectReadable(page.locator(".language-switcher .glyph"), "language globe");

      if (phone) {
        const more = bar.getByRole("button", { name: nameOf["bar.more"], exact: true });
        // Space, Enter and ArrowDown on the trigger each open the menu and focus its first item.
        for (const keyName of ["Space", "Enter", "ArrowDown"]) {
          await more.focus();
          await page.keyboard.press(keyName);
          await expect(page.getByRole("menu")).toBeVisible();
          await expect(page.getByRole("menuitemcheckbox").first()).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("menu")).toHaveCount(0);
          await expect(more).toBeFocused();
        }
        await more.press("Enter");
        const menu = page.getByRole("menu");
        // Every item has a computed name, and the glyphs read on the floating surface.
        const names = [
          nameOf["bar.profile"],
          nameOf["bar.localFolder"],
          ...LOCALES.map((code) => LOCALE_NAMES[code]),
          nameOf["theme.use"].replace("{theme}", nameOf["theme.paper"]),
          nameOf["bar.settings"],
        ];
        const nightOwl = nameOf["theme.use"].replace("{theme}", nameOf["theme.nightOwl"]);
        for (const name of names) {
          const item = menu
            .getByRole("menuitem", { name, exact: true })
            .or(menu.getByRole("menuitemcheckbox", { name, exact: true }))
            .or(menu.getByRole("menuitemradio", { name, exact: true }))
            .or(menu.getByRole("menuitem", { name: nightOwl, exact: true }));
          await expect(item.first()).toHaveAccessibleName(/\S/);
        }
        await expect(
          menu.getByRole("menuitemcheckbox", { name: nameOf["bar.profile"] }),
        ).toHaveAttribute("aria-checked", "false");
        for (const glyph of await menu.locator(".menu-icon svg").all()) {
          await expectReadable(glyph, "menu glyph");
        }
        await menu.getByRole("menuitem").first().hover();
        await expectReadable(menu.locator(".menu-icon svg").first(), "menu glyph hovered");
        // Tab closes the menu and leaves from the trigger.
        await page.keyboard.press("Tab");
        await expect(menu).toHaveCount(0);
        await expect(more).toBeFocused();
        // An outside click on nothing focusable returns focus to the trigger; the target is not in the menu.
        await more.click();
        await expect(menu).toBeVisible();
        const outside = page.locator(".topics-pane").first();
        expect(await outside.evaluate((node) => node.closest(".menu") === null)).toBe(true);
        await outside.click({ position: { x: 5, y: 5 } });
        await expect(menu).toHaveCount(0);
        await expect(more).toBeFocused();
        // An outside click on a focusable control leaves the focus on that control.
        await more.click();
        const viewing = page.getByRole("combobox", { name: nameOf["bar.viewingAs"] });
        await viewing.click();
        await expect(menu).toHaveCount(0);
        await expect(viewing).toBeFocused();
      }
      expect(checked.length).toBeGreaterThan(iconNames.length);
      assertRequests();
    });
  }
}

for (const code of LOCALES) {
  for (const view of [
    { label: "desktop", size: { width: 1280, height: 800 } },
    { label: "phone", size: { width: 390, height: 844 } },
  ] as const) {
    for (const theme of [
      { name: "night-owl", scheme: "dark" },
      { name: "paper", scheme: "light" },
    ] as const) {
      test(`the icon toolbar fits and reads well in ${LOCALE_NAMES[code]} on ${view.label} in ${theme.name}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme.scheme });
        await page.setViewportSize(view.size);
        await page.addInitScript((locale) => {
          localStorage.setItem("agent-collab-viewer.locale", locale);
        }, code);
        await page.goto("/");
        await page
          .getByRole("button", { name: catalogsByLocale[code]["welcome.openAnother"] })
          .click();
        await page
          .getByRole("button", { name: catalogsByLocale[code]["settings.openOffline"] })
          .click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme.name);

        const bar = page.locator(".bar-actions");
        await expectNoClipping(page, ".bar, .bar-actions, .bar-actions > *");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(0);
        // The controls stay on one row, however long the translated labels are.
        const tops = await bar
          .locator("> *")
          .evaluateAll((nodes) =>
            nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
          );
        expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(12);

        // Every button has a non-empty accessible name and the same text as its tooltip.
        const buttons = await bar.locator("button").evaluateAll((nodes) =>
          nodes.map((node) => ({
            name: node.getAttribute("aria-label") ?? "",
            title: node.getAttribute("title"),
            icon: node.querySelector("svg") !== null,
          })),
        );
        expect(buttons.length).toBeGreaterThan(0);
        for (const button of buttons) {
          expect(button.name.trim(), "accessible name").not.toBe("");
          if (button.icon) expect(button.title).toBe(button.name);
        }

        // Glyphs are readable: at least 3:1 against the toolbar, in both themes.
        const colors = await page.evaluate(() => {
          const background = getComputedStyle(
            document.querySelector(".bar") as Element,
          ).backgroundColor;
          return [...document.querySelectorAll(".bar-actions .icon-button")].map((node) => ({
            glyph: getComputedStyle(node).color,
            background,
          }));
        });
        expect(colors.length).toBeGreaterThan(0);
        for (const { glyph, background } of colors) {
          expect(contrast(glyph, background)).toBeGreaterThanOrEqual(3);
        }
        await saveScreenshot(page, `toolbar-${code}-${view.label}-${theme.name}.png`);

        if (view.size.width < 721) {
          const more = bar.getByRole("button", { name: catalogsByLocale[code]["bar.more"] });
          await more.focus();
          await page.keyboard.press("Enter");
          const menu = page.getByRole("menu");
          await expect(menu).toBeVisible();
          await expect(more).toHaveAttribute("aria-expanded", "true");
          const first = page.locator('[role^="menuitem"]').first();
          await expect(first).toBeFocused();
          await page.keyboard.press("ArrowDown");
          await expect(page.locator('[role^="menuitem"]').nth(1)).toBeFocused();
          await expectNoClipping(page, ".menu, .menu-item");
          // Settings sits at the bottom of the menu.
          await expect(page.getByRole("menuitem").last()).toHaveAccessibleName(
            catalogsByLocale[code]["bar.settings"],
          );
          await saveScreenshot(page, `toolbar-menu-${code}-${theme.name}.png`);
          await page.keyboard.press("Escape");
          await expect(menu).toHaveCount(0);
          await expect(more).toBeFocused();
          // An outside click closes it too.
          await more.click();
          await expect(menu).toBeVisible();
          await page
            .locator(".conversation, .topics-pane")
            .first()
            .click({ position: { x: 5, y: 5 } });
          await expect(menu).toHaveCount(0);
        } else {
          await expect(
            bar.getByRole("button", { name: catalogsByLocale[code]["bar.settings"], exact: true }),
          ).toBeVisible();
        }
      });
    }
  }
}

for (const code of LOCALES) {
  const messages = catalogsByLocale[code];
  for (const view of [
    { label: "desktop", size: { width: 1280, height: 800 } },
    { label: "phone", size: { width: 390, height: 844 } },
  ] as const) {
    test(`the loaded range, the jump to a date and an earlier original work in ${LOCALE_NAMES[code]} on ${view.label}`, async ({
      page,
    }) => {
      await page.setViewportSize(view.size);
      const assertRequests = await openViewer(page, "history");
      if (code !== "en" && view.size.width < 721) {
        await page.getByRole("button", { name: /^(More|その他|更多)$/ }).click();
        await page.getByRole("menuitemradio", { name: LOCALE_NAMES[code], exact: true }).click();
      } else if (code !== "en") {
        await page.getByLabel(en["language.label"]).selectOption(code);
      }
      await expect(page.locator("html")).toHaveAttribute("lang", code);
      await page.getByRole("button", { name: messages["nav.all"], exact: true }).click();
      const line = page.locator(".range-line");
      // The newest page: 50 messages, back to the day the 11th message was sent.
      await expect(line).toHaveText(
        translate(code, "range.loaded", { count: 50, date: "2026-09-04" }),
      );
      await expect(page.locator("h1")).toHaveCount(1);

      // The reply to the opening message says its original is earlier and offers to load it.
      const quote = page.locator(".quote.missing");
      await expect(quote).toContainText(
        translate(code, "chat.replyEarlier", { id: "\uE000" }).split("\uE000")[0] ?? "",
      );
      await expect(quote.getByRole("button", { name: messages["nav.loadOlder"] })).toBeVisible();

      // Jump with the keyboard: the date field, then Enter.
      const date = page.getByLabel(messages["range.jumpLabel"]);
      await date.fill("2026-09-02");
      await date.press("Enter");
      await expect(date).toBeFocused();
      await expect(line).toHaveText(
        translate(code, "range.loadedPast", { count: 6, from: "2026-09-01", to: "2026-09-02" }),
      );
      await expect(page.locator(".message")).toHaveCount(6);
      // The jumped range holds the opening message; no reply points outside it.
      await expect(page.locator(".quote.missing")).toHaveCount(0);

      const bar = await page.locator(".range-bar").boundingBox();
      expect((bar?.x ?? 0) + (bar?.width ?? 0)).toBeLessThanOrEqual(view.size.width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await saveScreenshot(page, `range-jump-${code}-${view.label}.png`);

      await page.getByRole("button", { name: messages["range.showNewest"] }).click();
      await expect(date).toBeFocused();
      await expect(line).toHaveText(
        translate(code, "range.loaded", { count: 50, date: "2026-09-04" }),
      );
      await page
        .locator(".quote.missing")
        .getByRole("button", { name: messages["nav.loadOlder"] })
        .click();
      await expect(line).toHaveText(
        translate(code, "range.loaded", { count: 60, date: "2026-09-01" }),
      );
      await expect(page.locator(".quote.missing")).toHaveCount(0);
      assertRequests();
    });
  }
}

test("a jump in the monthly layout lists one month folder and reads one page", async ({ page }) => {
  const assertRequests = await openViewer(page, "history-monthly");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.locator(".range-line")).toHaveText(
    translate("en", "range.loaded", { count: 50, date: "2026-08-04" }),
  );
  assertRequests.apiRequests().length = 0;
  const date = page.getByLabel("Jump to date");
  await date.fill("2026-07-02");
  await date.press("Enter");
  await expect(page.locator(".message")).toHaveCount(6);
  // Exactly the July folder and its six files: no root, inbox, other month or head request.
  const requests = assertRequests.apiRequests();
  expect(
    requests.filter((path) => path.includes("/git/trees/")).map((path) => path.split("/").pop()),
  ).toEqual(["month-2026-07"]);
  expect(requests.filter((path) => path.includes("/git/blobs/"))).toHaveLength(6);
  expect(requests).toHaveLength(7);
  assertRequests();
});

// "@csp" also puts these in the WebKit project (see playwright.config.ts).
for (const code of LOCALES) {
  const messages = catalogsByLocale[code];
  for (const view of [
    { label: "desktop", size: { width: 1280, height: 800 } },
    { label: "phone", size: { width: 390, height: 844 } },
  ] as const) {
    test(`the local folder status bar names who made the last change in ${LOCALE_NAMES[code]} on ${view.label} @csp`, async ({
      page,
    }) => {
      await page.setViewportSize(view.size);
      await page.addInitScript((locale) => {
        localStorage.setItem("agent-collab-viewer.locale", locale);
      }, code);
      await installFakeFolder(page, { picker: "works" });
      await page.goto("/");
      await page.getByRole("button", { name: messages["welcome.openLocal"] }).click();
      const last = page.locator(".source-indicator .last-changed");
      await expect(last).toContainText("alice-agent");
      await expect(last).toContainText(" · ");
      await expectNoClipping(page, ".source-indicator, .source-indicator span");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await saveScreenshot(page, `last-change-by-${code}-${view.label}.png`);
    });
  }
}

test("a topic-layout local folder shows a message added under a topic after Refresh", async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  await installFakeFolder(page, { picker: "works", layout: "topic" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open local folder (experimental)" }).click();
  await expect(page.getByText("The first message from the local clone.")).toBeVisible();
  const last = page.locator(".source-indicator .last-changed");
  await expect(last).toContainText("· alice-agent");

  await page.evaluate(() => {
    const clone = (
      window as unknown as { fakeClone: { write: (p: string, c: string, m: number) => void } }
    ).fakeClone;
    clone.write(
      "topics/api/inbox/2026-10/2026-10-08T0905-bob-agent-api-01.md",
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
        "A message that arrived under a topic.",
      ].join("\n"),
      Date.now(),
    );
  });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("A message that arrived under a topic.")).toBeVisible();
  await expect(last).toContainText("· bob-agent");
});

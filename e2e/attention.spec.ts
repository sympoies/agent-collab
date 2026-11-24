import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { en } from "../src/i18n/catalog";
import { messageText } from "../tests/support";

const PARTICIPANTS = "participants: alice-agent, bob-agent\n";
const topicId = (topic: string, sequence: number) => {
  if (sequence >= 100) {
    return `2026-11-01T09${String(sequence - 100).padStart(2, "0")}-alice-agent-${topic}-01`;
  }
  const day = String(Math.min(sequence, 30)).padStart(2, "0");
  const time = sequence <= 30 ? "0900" : `10${String(sequence - 31).padStart(2, "0")}`;
  return `2026-11-${day}T${time}-alice-agent-${topic}-01`;
};

interface TopicData {
  readonly name: string;
  readonly messages?: readonly { readonly day: number; readonly body: string }[];
  readonly open?: readonly { readonly day: number; readonly summary: string }[];
}

function topicRepository(revision: string, topics: readonly TopicData[]): string {
  const files = [
    {
      path: ".agent-collab",
      text: `collab-protocol: 1\ninbox-layout: topic\n${PARTICIPANTS}`,
    },
    {
      path: "index.md",
      text: [
        "| topic | title | status |",
        "|---|---|---|",
        ...topics.map(({ name }) => `| ${name} | ${name} | open |`),
      ].join("\n"),
    },
  ];
  for (const topic of topics) {
    const messages = topic.messages ?? [{ day: 1, body: `Recent ${topic.name} message.` }];
    if (messages.length > 0) {
      files.push({
        path: `topics/${topic.name}/index.md`,
        text: [
          "| id | from | to | type | topic | reply_to | needs | summary |",
          "|---|---|---|---|---|---|---|---|",
          ...messages.map(
            ({ day }) =>
              `| ${topicId(topic.name, day)} | alice-agent | bob-agent | info | ${topic.name} | | none | summary |`,
          ),
        ].join("\n"),
      });
    }
    if (topic.open !== undefined) {
      files.push({
        path: `topics/${topic.name}/open.md`,
        text: [
          "# Open items",
          "",
          "## Unanswered questions",
          "",
          "| id | from | to | needs | due | summary |",
          "|---|---|---|---|---|---|",
          ...topic.open.map(
            ({ day, summary }) =>
              `| ${topicId(topic.name, day)} | alice-agent | bob-agent | review | | ${summary} |`,
          ),
        ].join("\n"),
      });
    }
    for (const { day, body } of messages) {
      files.push({
        path: `topics/${topic.name}/inbox/2026-11/${topicId(topic.name, day)}.md`,
        text: messageText(topicId(topic.name, day), "alice-agent", topic.name, {}, body),
      });
    }
  }
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-11-25T00:00:00.000Z",
    revision,
    files,
  });
}

function legacyRepository(revision: string): string {
  const id = "2026-11-01T0900-alice-agent-api-01";
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-11-25T00:00:00.000Z",
    revision,
    files: [
      { path: ".agent-collab", text: `collab-protocol: 1\ninbox-layout: monthly\n${PARTICIPANTS}` },
      {
        path: `inbox/2026-11/${id}.md`,
        text: messageText(id, "alice-agent", "api", {}, "Legacy inbox message."),
      },
    ],
  });
}

async function deploy(
  page: Page,
  current: () => string,
  followed: readonly string[] = [],
): Promise<void> {
  await page.addInitScript(
    (followedTopics) => {
      const key = `hosted:${location.origin}/`;
      localStorage.setItem(
        `agent-collab-viewer.identity:${key}`,
        JSON.stringify({ viewingAs: "bob-agent", colors: {}, names: {} }),
      );
      if (followedTopics.length > 0) {
        localStorage.setItem(
          `agent-collab-viewer.topics:${key}`,
          JSON.stringify({ follow: followedTopics, mute: [], pin: [], hide: [], seen: {} }),
        );
      }
    },
    [...followed],
  );
  await page.route("**/hosted-snapshot.json", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: current() });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Collaboration snapshot" })).toBeVisible();
}

async function openTopicOptions(page: Page, topic: string): Promise<void> {
  const menu = page.locator(
    `.topic-preference-menu:has(> summary[aria-label="Options for #${topic}"])`,
  );
  if (!(await menu.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await menu.locator("summary").click();
  }
}

test("follow and unfollow control which messages Attention loads @csp", async ({
  page,
  browserName,
}) => {
  await deploy(page, () =>
    topicRepository("r1", [
      { name: "api", messages: [{ day: 1, body: "Followed API message." }], open: [] },
    ]),
  );
  await openTopicOptions(page, "api");
  await page.getByRole("button", { name: "Follow #api" }).click();
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(page.getByText("Followed API message.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent messages in followed topics" }),
  ).toBeVisible();
  await expect(page.locator(".attention-coverage-list")).toContainText("#api");
  await expect(page.locator(".attention-coverage-list")).toContainText(
    "Newest message pages loaded at",
  );

  if (browserName === "chromium") {
    const dir = process.env.PLAYWRIGHT_SCREENSHOT_DIR;
    if (dir === undefined) throw new Error("Missing screenshot output directory.");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, "attention-desktop.png"), fullPage: true });
    const mobile = await page.context().newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    await deploy(
      mobile,
      () =>
        topicRepository("r1", [
          { name: "api", messages: [{ day: 1, body: "Followed API message." }], open: [] },
        ]),
      ["api"],
    );
    await mobile.getByRole("button", { name: "Attention", exact: true }).click();
    await expect(mobile.locator(".attention-view")).toBeVisible();
    await expect(mobile.getByText("Followed API message.")).toBeVisible();
    await mobile.screenshot({ path: join(dir, "attention-mobile.png"), fullPage: true });
    await mobile.close();
  }

  await openTopicOptions(page, "api");
  await page.getByRole("button", { name: "Unfollow #api" }).click();
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(page.getByText("Follow a topic to include its recent messages.")).toBeVisible();
  await expect(page.getByText("Followed API message.")).toHaveCount(0);
});

test("unread counts follow new messages and clear after viewing the topic @csp", async ({
  page,
}) => {
  let body = topicRepository("r1", [
    { name: "api", messages: [{ day: 1, body: "First API message." }], open: [] },
  ]);
  await deploy(page, () => body);
  await openTopicOptions(page, "api");
  await page.getByRole("button", { name: "Follow #api" }).click();
  const topicRow = page.locator(".topics > button.topic-entry-button").filter({ hasText: "#api" });
  await expect(topicRow).toHaveAttribute("aria-description", "1 unread");
  await topicRow.click();
  await expect(page.getByText("First API message.")).toBeVisible();
  await expect(page.locator('.topics .count[data-count="1"]')).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();

  body = topicRepository("r2", [
    {
      name: "api",
      messages: [
        { day: 1, body: "First API message." },
        { day: 2, body: "Second API message." },
      ],
      open: [],
    },
  ]);
  await page.getByRole("button", { name: en["bar.refresh"], exact: true }).click();
  await expect(
    page.locator('.topics > button.topic-entry-button[aria-description="1 unread"]'),
  ).toBeVisible();
  await page.locator(".topics > button.topic-entry-button").filter({ hasText: "#api" }).click();
  await expect(page.getByText("Second API message.")).toBeVisible();
  await expect(page.locator('.topics .count[data-count="1"]')).toHaveCount(0);
});

test("only followed topics produce wake-up announcements @csp", async ({ page }) => {
  let body = topicRepository("r1", [
    { name: "api", messages: [{ day: 1, body: "Initial API message." }], open: [] },
  ]);
  await deploy(page, () => body);
  const liveRegion = page.locator('.sr-only[role="status"]');
  await expect(liveRegion).toHaveText("");

  body = topicRepository("r2", [
    {
      name: "api",
      messages: [
        { day: 1, body: "Initial API message." },
        { day: 2, body: "Unfollowed arrival." },
      ],
      open: [],
    },
  ]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Unfollowed arrival.")).toBeVisible();
  await expect(liveRegion).toHaveText("");

  await openTopicOptions(page, "api");
  await page.getByRole("button", { name: "Follow #api" }).click();
  body = topicRepository("r3", [
    {
      name: "api",
      messages: [
        { day: 1, body: "Initial API message." },
        { day: 2, body: "Unfollowed arrival." },
        { day: 3, body: "Followed arrival." },
      ],
      open: [],
    },
  ]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(liveRegion).toContainText("1 new message arrived.");
  const announcement = await liveRegion.textContent();

  await openTopicOptions(page, "api");
  await page.getByRole("button", { name: "Mute #api" }).click();
  body = topicRepository("r4", [
    {
      name: "api",
      messages: [
        { day: 1, body: "Initial API message." },
        { day: 2, body: "Unfollowed arrival." },
        { day: 3, body: "Followed arrival." },
        { day: 4, body: "Muted arrival." },
      ],
      open: [],
    },
  ]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Muted arrival.")).toBeVisible();
  await expect(liveRegion).toHaveText(announcement ?? "");
});

test("mute, pin, hide, and restore update topic visibility and Attention @csp", async ({
  page,
}) => {
  await deploy(page, () =>
    topicRepository("r1", [
      {
        name: "api",
        messages: [{ day: 1, body: "API message." }],
        open: [{ day: 1, summary: "API item." }],
      },
      {
        name: "ops",
        messages: [{ day: 2, body: "Ops message." }],
        open: [{ day: 2, summary: "Ops item." }],
      },
    ]),
  );
  await openTopicOptions(page, "api");
  await page.getByRole("button", { name: "Pin #api" }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).focus();
  await page.mouse.move(1200, 50);
  await expect(page.locator(".topics > button").nth(4)).toHaveText("#api");
  await openTopicOptions(page, "api");
  await page.getByRole("button", { name: "Mute #api" }).click();
  await expect(
    page.locator(".topics > button.topic-entry-button").filter({ hasText: "#api" }),
  ).toHaveAttribute("aria-description", "1 unread");
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open item in #api" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open item in #ops" })).toBeVisible();
  await expect(page.locator(".attention-coverage-list")).toContainText("#ops");
  await expect(page.locator(".attention-coverage-list")).toContainText("Open-item files read at");

  await openTopicOptions(page, "api");
  await page.getByRole("button", { name: "Hide #api" }).click();
  await expect(
    page.locator(".topics > button.topic-entry-button").filter({ hasText: "#api" }),
  ).toHaveCount(0);
  await page.getByText("Hidden (1)").click();
  await expect(page.locator(".hidden-topic-row > button")).toHaveText("#api");
  await page.locator(".hidden-topic-row > button").click();
  await expect(
    page.locator(".topics > button.topic-entry-button").filter({ hasText: "#api" }),
  ).toBeVisible();
});

test("Attention shows open items and followed messages in legacy inboxes @csp", async ({
  page,
}) => {
  await deploy(page, () => legacyRepository("r1"));
  await openTopicOptions(page, "api");
  await page.getByRole("button", { name: "Follow #api" }).click();
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(
    page.getByText("This repository layout provides messages from followed topics only."),
  ).toBeVisible();
  await expect(page.getByText("Legacy inbox message.")).toBeVisible();
});

test("Attention loads the 30 most recent open topics and offers an explicit load-all action @csp", async ({
  page,
}) => {
  const topics: TopicData[] = Array.from({ length: 31 }, (_, index) => {
    const name = `topic-${String(index).padStart(2, "0")}`;
    const messages = [{ day: index + 1, body: `Message for ${name}.` }];
    if (index === 1) return { name, messages };
    return { name, messages, open: index === 0 ? [{ day: 1, summary: "Oldest open item." }] : [] };
  });
  await deploy(page, () => topicRepository("r1", topics));
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(page.getByText("Open topics not loaded: 1.")).toBeVisible();
  await expect(page.locator(".attention-coverage-list")).toContainText("#topic-00");
  await expect(page.locator(".attention-coverage-list")).toContainText("#topic-01");
  await expect(page.locator(".attention-coverage-list")).toContainText(
    "No usable open-item file as of",
  );
  await expect(page.locator(".attention-coverage-list")).toContainText(
    "Open-item files not read as of",
  );
  await expect(page.getByRole("button", { name: "Open item in #topic-00" })).toHaveCount(0);
  await page.getByRole("button", { name: "Load all open topics" }).click();
  await expect(page.getByRole("button", { name: "Open item in #topic-00" })).toBeVisible();
  await expect(page.locator(".attention-coverage-list")).toContainText("#topic-00");
});

test("opening a same-day older Attention item loads its real message @csp", async ({ page }) => {
  const messages = Array.from({ length: 51 }, (_, index) => ({
    day: index + 100,
    body: index === 0 ? "Older verified message body." : `Recent message ${String(index + 1)}.`,
  }));
  await deploy(page, () =>
    topicRepository("r1", [
      { name: "api", messages, open: [{ day: 100, summary: "Older item." }] },
    ]),
  );
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await page.getByRole("button", { name: "Open item in #api" }).click();
  await expect(page.getByText("Older verified message body.")).toBeVisible();
});

test("topic preferences work in memory when browser storage throws @csp", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("Storage unavailable", "SecurityError");
    };
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    };
  });
  await page.route("**/hosted-snapshot.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: topicRepository("r1", [
        { name: "api", messages: [{ day: 1, body: "Storage fallback message." }], open: [] },
      ]),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Collaboration snapshot" })).toBeVisible();
  await openTopicOptions(page, "api");
  await page.getByRole("button", { name: "Follow #api" }).click();
  await page.getByRole("button", { name: "Attention", exact: true }).click();
  await expect(page.locator(".conversation h2")).toHaveText("Attention");
  await expect(page.getByText(/Followed topics loaded: 1\./)).toBeVisible();
  expect(errors).toEqual([]);
});

// A repository in the topic layout with 5,000 messages: the page opens by reading one page of
// messages, not the repository (docs/design/topics-and-scale.md, section 6.1). Synthetic data only.

import { expect, test, type Route } from "@playwright/test";

const TOPICS = Array.from({ length: 12 }, (_, i) => `topic-${String(i)}`);
const TOTAL = 5000;
const MARKER = "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n";

interface Fixture {
  readonly n: number;
  readonly topic: string;
  readonly month: string;
  readonly id: string;
}

/** Message n: 12 topics round robin, 22 months of 227 messages, newest has the highest n. */
function fixture(n: number): Fixture {
  const topic = TOPICS[n % 12] as string;
  const monthIndex = Math.floor((n * 22) / TOTAL);
  const year = 2025 + Math.floor(monthIndex / 12);
  const month = `${String(year)}-${String((monthIndex % 12) + 1).padStart(2, "0")}`;
  const day = String(1 + (n % 28)).padStart(2, "0");
  const time = `${String(Math.floor(n / 60) % 24).padStart(2, "0")}${String(n % 60).padStart(2, "0")}`;
  return { n, topic, month, id: `${month}-${day}T${time}-alice-agent-${topic}-01` };
}

const ALL = Array.from({ length: TOTAL }, (_, n) => fixture(n));
/** Newest first by file name, the order the viewer pages in. */
const NEWEST_FIRST = [...ALL].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
const BY_TOPIC_MONTH = new Map<string, Fixture[]>();
for (const message of ALL) {
  const key = `${message.topic}/${message.month}`;
  BY_TOPIC_MONTH.set(key, [...(BY_TOPIC_MONTH.get(key) ?? []), message]);
}
const MONTHS_OF = (topic: string) =>
  [...new Set(ALL.filter((m) => m.topic === topic).map((m) => m.month))].sort();

function text(message: Fixture): string {
  return [
    "---",
    `id: ${message.id}`,
    "from: alice-agent",
    "to: bob-agent",
    `topic: ${message.topic}`,
    "type: info",
    "reply_to:",
    "refs:",
    "needs: none",
    "due:",
    "---",
    `Synthetic message number ${String(message.n)} for ${message.topic}.`,
  ].join("\n");
}

const entry = (path: string, sha: string, type: "blob" | "tree") => ({
  path,
  sha,
  type,
  mode: type === "tree" ? "040000" : "100644",
});

function json(route: Route, value: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers,
    body: JSON.stringify(value),
  });
}

test("a 5,000-message topic repository opens by reading one page and pages on demand", async ({
  page,
}) => {
  const requests: string[] = [];
  const unhandled: string[] = [];
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/repos/alice-agent/fixture-repo", "");
    if (request.headers()["authorization"] !== "Bearer fake-token") {
      unhandled.push(`unauthenticated ${path}`);
      await route.fulfill({ status: 401, body: "{}" });
      return;
    }
    requests.push(path);
    if (path === "/git/ref/heads/main") {
      await json(route, { object: { sha: "rev" } }, { etag: '"rev"' });
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
        tree: TOPICS.map((t) => entry(t, `topic:${t}`, "tree")),
      });
    } else if (path.startsWith("/git/trees/topic:")) {
      const topic = path.slice("/git/trees/topic:".length);
      await json(route, { truncated: false, tree: [entry("inbox", `inbox:${topic}`, "tree")] });
    } else if (path.startsWith("/git/trees/inbox:")) {
      const topic = path.slice("/git/trees/inbox:".length);
      await json(route, {
        truncated: false,
        tree: MONTHS_OF(topic).map((month) => entry(month, `month:${topic}/${month}`, "tree")),
      });
    } else if (path.startsWith("/git/trees/month:")) {
      const key = decodeURIComponent(path.slice("/git/trees/month:".length));
      await json(route, {
        truncated: false,
        tree: (BY_TOPIC_MONTH.get(key) ?? []).map((m) =>
          entry(`${m.id}.md`, `message:${String(m.n)}`, "blob"),
        ),
      });
    } else if (path === "/git/blobs/marker") {
      await route.fulfill({ status: 200, body: MARKER });
    } else if (path === "/git/blobs/index") {
      await route.fulfill({ status: 200, body: "| topic | title | status |\n|---|---|---|\n" });
    } else if (path.startsWith("/git/blobs/message:")) {
      const message = ALL[Number(path.slice("/git/blobs/message:".length))];
      await route.fulfill({ status: 200, body: message === undefined ? "" : text(message) });
    } else {
      unhandled.push(path);
      await route.fulfill({ status: 500, body: "{}" });
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

  const said = (message: Fixture) => `Synthetic message number ${String(message.n)} for`;
  const newest = NEWEST_FIRST[0] as Fixture;
  await expect(page.getByText(said(newest))).toBeVisible();
  const messageBlobs = () => requests.filter((path) => path.startsWith("/git/blobs/message:"));
  const numbers = (paths: string[]) =>
    paths.map((path) => Number(path.slice("/git/blobs/message:".length))).sort((x, y) => x - y);
  const wanted = (count: number) =>
    NEWEST_FIRST.slice(0, count)
      .map((m) => m.n)
      .sort((x, y) => x - y);
  // Exactly the newest page, and the repository's other 4,950 messages are never fetched.
  expect(numbers(messageBlobs())).toEqual(wanted(50));
  expect(requests.length).toBeLessThan(150);
  // The newest months of the 12 topics are listed, not the whole history.
  expect(
    requests.filter((path) => path.startsWith("/git/trees/month:")).length,
  ).toBeLessThanOrEqual(24);
  await expect(page.locator(".message")).toHaveCount(50);

  await page.getByRole("button", { name: "Load older messages" }).click();
  await expect(page.locator(".message")).toHaveCount(100);
  // The second page is exactly the next 50 in order, nothing skipped or repeated.
  expect(numbers(messageBlobs())).toEqual(wanted(100));
  expect(unhandled).toEqual([]);
});

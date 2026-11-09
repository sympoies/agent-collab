// A reload reopens the GitHub repository the reader last had open, with the token saved for it, and
// lands on Settings with the usual error when that no longer works. The GitHub API is stubbed:
// synthetic data only, no network. The "@csp" tag also runs these in WebKit.

import { expect, test, type Page, type Route } from "@playwright/test";

import { messageText } from "../tests/support";
import { topicSnapshot } from "../tests/topic-snapshot-fixture";

const ID = "2026-10-08T0900-alice-agent-api-01";
const MARKER = "collab-protocol: 1\nparticipants: alice-agent\n";
const MESSAGE = messageText(ID, "alice-agent", "api", {}, "Read from the stubbed repository.");

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
    headers: { etag: '"rev"' },
    body: JSON.stringify(value),
  });
}

/** A one-message monthly repository; `reject` makes the API refuse the token. */
async function serve(page: Page, state: { reject: boolean; tokens: string[] }) {
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/repos/alice-org/collab", "");
    state.tokens.push(request.headers()["authorization"] ?? "");
    if (state.reject) {
      await route.fulfill({ status: 401, body: "{}" });
    } else if (path === "/git/ref/heads/main") {
      await json(route, { object: { sha: "rev" } });
    } else if (path === "/git/commits/rev") {
      await json(route, { tree: { sha: "root" } });
    } else if (path === "/git/trees/root") {
      await json(route, {
        truncated: false,
        tree: [entry(".agent-collab", "marker", "blob"), entry("inbox", "inbox", "tree")],
      });
    } else if (path === "/git/trees/inbox") {
      await json(route, { truncated: false, tree: [entry("2026-10", "month", "tree")] });
    } else if (path === "/git/trees/month") {
      await json(route, { truncated: false, tree: [entry(`${ID}.md`, "message", "blob")] });
    } else if (path === "/git/blobs/marker") {
      await route.fulfill({ status: 200, body: MARKER });
    } else if (path === "/git/blobs/message") {
      await route.fulfill({ status: 200, body: MESSAGE });
    } else {
      await route.fulfill({ status: 404, body: "{}" });
    }
  });
}

async function connect(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Open another repository" }).click();
  await page.getByRole("textbox", { name: "Repository", exact: true }).fill("alice-org/collab");
  await page.getByLabel("Branch").fill("main");
  await page.getByLabel("Access token").fill("fake-token");
  await page.getByRole("radio", { name: /Encrypted in this browser/ }).check();
  await page.getByRole("button", { name: "Save and open" }).click();
  await expect(page.getByText("Read from the stubbed repository.")).toBeVisible();
}

test.describe("a reload reopens the GitHub repository @csp", () => {
  test("the demo query leaves the saved repository available @csp", async ({ page }) => {
    const state = { reject: false, tokens: [] as string[] };
    await serve(page, state);
    await connect(page);
    const snapshot = await topicSnapshot();
    await page.route("**/demo-snapshot.json", (route) => route.fulfill({ json: snapshot }));
    state.tokens.length = 0;
    await page.goto("/?demo");
    await expect(page.locator("h1")).toHaveText("Live demo");
    expect(state.tokens).toEqual([]);
    await page.goto("/");
    await expect(page.getByText("Read from the stubbed repository.")).toBeVisible();
    expect(state.tokens.length).toBeGreaterThan(0);
  });

  test("it comes back with its messages and the saved token @csp", async ({ page }) => {
    const state = { reject: false, tokens: [] as string[] };
    await serve(page, state);
    await connect(page);

    state.tokens.length = 0;
    await page.reload();
    await expect(page.locator("h1")).toHaveText("alice-org/collab");
    await expect(page.getByText("Read from the stubbed repository.")).toBeVisible();
    // Only the configured API host sees the token, as when the reader opens it by hand.
    expect(state.tokens.length).toBeGreaterThan(0);
    expect(new Set(state.tokens)).toEqual(new Set(["Bearer fake-token"]));
  });

  test("a token the API now refuses lands on Settings with the usual error @csp", async ({
    page,
  }) => {
    const state = { reject: false, tokens: [] as string[] };
    await serve(page, state);
    await connect(page);

    state.reject = true;
    await page.reload();
    await expect(page.locator("#github-form")).toBeVisible();
    await expect(page.getByRole("alert").first()).toContainText("token was rejected");
  });

  test("after Forget a reload starts on the welcome screen @csp", async ({ page }) => {
    const state = { reject: false, tokens: [] as string[] };
    await serve(page, state);
    await connect(page);

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Forget what this browser remembers" }).click();
    await page.getByRole("button", { name: "Forget everything" }).click();
    await expect(page.getByRole("status")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Open saved repository" })).toBeVisible();
    await expect(page.locator("#github-form")).toHaveCount(0);
  });
});

// The hosted demo reads a bundled snapshot, not the live API. This runs that whole path against a
// snapshot of a topic-layout repository built by the snapshot script's own rules (synthetic data).

import { expect, test } from "@playwright/test";

import { formatDateTime } from "../src/i18n/translate";
import { DIAGRAM, LEGACY_API_ID, topicSnapshot } from "../tests/topic-snapshot-fixture";

test("the hosted demo opens a topic-layout snapshot without any API request", async ({ page }) => {
  const snapshot = await topicSnapshot();
  const apiRequests: string[] = [];
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  await page.route("**/demo-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
  await page.route("https://api.github.com/**", async (route) => {
    apiRequests.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 500, body: "{}" });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open live demo" }).click();
  await expect(page.getByText(formatDateTime("en", new Date(snapshot.generatedAt)))).toBeVisible();

  // The topics of the newest page are listed; the legacy-only topic is older and appears once the
  // history is paged back (the list comes from the loaded messages until the topic index drives it).
  const topics = page.getByRole("navigation", { name: "Topics" });
  for (const topic of ["api", "general", "onboarding"]) {
    await expect(topics.getByText(`#${topic}`, { exact: true })).toBeVisible();
  }
  await expect(topics.getByText("#recipe-legacy", { exact: true })).toHaveCount(0);

  // A topic opens on its newest messages, with the attachments its refs name; Load older pages
  // back to the legacy root-inbox message that belongs to the same topic.
  await topics.getByText("#api", { exact: true }).click();
  await expect(page.getByText("API message").first()).toBeVisible();
  await expect(page.getByText("diagram.png")).toBeVisible();
  await expect(page.getByText("fields.csv")).toBeVisible();
  // A listing-only attachment (the PNG) still resolves: its card shows the real size and path,
  // not the "not in the repository" note.
  const diagram = page.locator(".file-card", { hasText: "diagram.png" });
  await diagram.locator("summary").click();
  await expect(diagram.locator(".file-meta")).toContainText(`${String(DIAGRAM.length)} B`);
  await expect(diagram.locator(".file-meta")).toContainText("topics/api/diagram.png");
  await expect(diagram).not.toContainText("not in the repository");
  const legacy = page.getByText("Legacy kickoff.");
  for (let step = 0; step < 8 && !(await legacy.isVisible()); step += 1) {
    const before = await page.locator(".message").count();
    await page.locator("button.older").click();
    await expect.poll(() => page.locator(".message").count()).toBeGreaterThan(before);
  }
  await expect(legacy).toBeVisible();
  await expect(page.locator(`#msg-${LEGACY_API_ID}`)).toBeVisible();

  // A topic that exists only in the legacy inbox is listed once its message is loaded, and opens.
  await expect(topics.getByText("#recipe-legacy", { exact: true })).toBeVisible();
  await topics.getByText("#recipe-legacy", { exact: true }).click();
  await expect(page.getByText("Only in the legacy inbox.")).toBeVisible();

  expect(apiRequests).toEqual([]);
  expect(problems).toEqual([]);
});

import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { topicSnapshot } from "../tests/topic-snapshot-fixture";

for (const width of [390, 1280]) {
  test(`demo query opens the snapshot without an API request at ${String(width)}px @csp`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const snapshot = await topicSnapshot();
    const requests: string[] = [];
    await page.route("**/demo-snapshot.json", (route) => route.fulfill({ json: snapshot }));
    await page.route("https://api.github.com/**", (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
    await page.goto("/?demo");
    await expect(page.getByText(/Snapshot copy, not live/)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Topics" })).toBeVisible();
    const screenshots = process.env.DEMO_SCREENSHOTS;
    if (screenshots !== undefined) {
      for (const theme of ["paper", "night-owl"]) {
        await page.evaluate((value) => {
          localStorage.setItem("agent-collab-viewer.theme", value);
        }, theme);
        await page.reload();
        await expect(page.getByText(/Snapshot copy, not live/)).toBeVisible();
        await page.screenshot({ path: join(screenshots, `demo-${String(width)}-${theme}.png`) });
      }
    }
    if (width === 390) {
      await page.getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
    } else {
      await page.getByRole("button", { name: "Settings" }).click();
    }
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(requests).toEqual([]);
  });
}

test("unrelated query and message hash do not open the demo @csp", async ({ page }) => {
  for (const path of ["/", "/?other=demo", "/#msg-2026-11-04T0901-alice-agent-demo-01"]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: "Open live demo" })).toBeVisible();
  }
});

test("a failed demo load returns to the welcome screen with an error @csp", async ({ page }) => {
  await page.route("**/demo-snapshot.json", (route) => route.fulfill({ status: 404 }));
  await page.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    const script = await response.text();
    const marker =
      "collab-protocol: 1\ninbox-layout: monthly\nparticipants: alice-agent, bob-agent";
    expect(script).toContain(marker);
    await route.fulfill({ response, body: script.replaceAll(marker, "invalid demo marker") });
  });
  await page.goto("/?demo");
  await expect(page.getByRole("button", { name: "Open live demo" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Unexpected error while loading messages.");
});

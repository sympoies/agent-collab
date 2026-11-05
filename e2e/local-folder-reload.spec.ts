// A local folder survives a reload (Chromium only: it needs showDirectoryPicker). The picked
// folder is a real directory handle from the browser's private file system, so it goes through
// the real IndexedDB structured clone and permission API. Synthetic data only.

import { expect, test, type Page } from "@playwright/test";

const MARKER = "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n";
const MESSAGE = [
  "---",
  "id: 2026-10-08T0900-alice-agent-api-01",
  "from: alice-agent",
  "to: all",
  "topic: api",
  "type: info",
  "reply_to:",
  "refs:",
  "needs: none",
  "due:",
  "---",
  "The first message from the local clone.",
].join("\n");

test.skip(({ browserName }) => browserName !== "chromium", "needs the File System Access API");

async function installPicker(page: Page) {
  await page.addInitScript(
    ({ marker, message }) => {
      Object.assign(window, {
        showDirectoryPicker: async () => {
          const root = await navigator.storage.getDirectory();
          const clone = await root.getDirectoryHandle("demo-clone", { create: true });
          const write = async (
            directory: FileSystemDirectoryHandle,
            name: string,
            text: string,
          ) => {
            const file = await directory.getFileHandle(name, { create: true });
            const stream = await file.createWritable();
            await stream.write(text);
            await stream.close();
          };
          await write(clone, ".agent-collab", marker);
          const inbox = await clone.getDirectoryHandle("inbox", { create: true });
          const month = await inbox.getDirectoryHandle("2026-10", { create: true });
          await write(month, "2026-10-08T0900-alice-agent-api-01.md", message);
          return clone;
        },
      });
    },
    { marker: MARKER, message: MESSAGE },
  );
}

async function installTopicPicker(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      showDirectoryPicker: async () => {
        const root = await navigator.storage.getDirectory();
        const clone = await root.getDirectoryHandle("topic-clone", { create: true });
        const write = async (directory: FileSystemDirectoryHandle, name: string, text: string) => {
          const file = await directory.getFileHandle(name, { create: true });
          const stream = await file.createWritable();
          await stream.write(text);
          await stream.close();
        };
        await write(
          clone,
          ".agent-collab",
          "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n",
        );
        const topics = await clone.getDirectoryHandle("topics", { create: true });
        const api = await topics.getDirectoryHandle("api", { create: true });
        const inbox = await api.getDirectoryHandle("inbox", { create: true });
        const month = await inbox.getDirectoryHandle("2026-11", { create: true });
        await write(
          month,
          "2026-11-04T0900-alice-agent-api-01.md",
          [
            "---",
            "id: 2026-11-04T0900-alice-agent-api-01",
            "from: alice-agent",
            "to: all",
            "topic: api",
            "type: info",
            "reply_to:",
            "refs:",
            "needs: none",
            "due:",
            "---",
            "The topic message remains unopened.",
          ].join("\n"),
        );
        return clone;
      },
    });
  });
}

test("Viewing as lists a local topic roster before opening a topic and remembers the choice", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installTopicPicker(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open local folder (experimental)" }).click();
  await expect(page.getByRole("button", { name: "#api", exact: true })).toBeVisible();
  await expect(page.getByText("The topic message remains unopened.")).toHaveCount(0);

  const identity = page.locator(".bar-actions .identity-button");
  await identity.click();
  const panel = page.getByRole("region", { name: "Profile & colors" });
  const viewingAs = panel.getByLabel("Viewing as");
  await expect(viewingAs.locator("option")).toHaveText(["Observer", "alice-agent", "bob-agent"]);
  await viewingAs.selectOption("bob-agent");
  await page.keyboard.press("Escape");
  await expect(identity).toHaveAttribute(
    "aria-label",
    "Viewing as bob-agent. Open Profile & colors",
  );

  await page.reload();
  await expect(page.getByRole("button", { name: "#api", exact: true })).toBeVisible();
  await identity.click();
  await expect(panel.getByLabel("Viewing as")).toHaveValue("bob-agent");
});

test("a reload returns to the local folder and the person chosen in it", async ({ page }) => {
  await installPicker(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open local folder (experimental)" }).click();
  await expect(page.getByText("The first message from the local clone.")).toBeVisible();
  await page.locator(".bar-actions .identity-button").click();
  const panel = page.getByRole("region", { name: "Profile & colors" });
  await panel.getByLabel("Viewing as").selectOption("bob-agent");
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator("h1")).toHaveText("Local folder: demo-clone");
  await expect(page.getByText("The first message from the local clone.")).toBeVisible();
  await page.locator(".bar-actions .identity-button").click();
  await expect(panel.getByLabel("Viewing as")).toHaveValue("bob-agent");
  await page.keyboard.press("Escape");
});

test("after leaving the folder a reload offers Reopen, and Forget removes it", async ({ page }) => {
  await installPicker(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open local folder (experimental)" }).click();
  await expect(page.getByText("The first message from the local clone.")).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open offline demo" }).click();
  await expect(page.locator("h1")).toHaveText("Demo repository");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Reopen demo-clone" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: "Reopen demo-clone" }).click();
  // On a phone the topic list comes first.
  await expect(page.locator("h1")).toHaveText("Local folder: demo-clone");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open offline demo" }).click();
  // The demo must be on screen (so the folder is no longer the last viewer) before the reload.
  await expect(page.locator("h1")).toHaveText("Demo repository");
  await page.reload();
  await page.getByRole("button", { name: "Forget this folder" }).click();
  await expect(page.getByRole("button", { name: "Reopen demo-clone" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Reopen demo-clone" })).toHaveCount(0);
});

import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const screenshots = process.env.PLAYWRIGHT_SCREENSHOT_DIR;
if (screenshots === undefined)
  throw new Error("Run `pnpm test:browser` with PLAYWRIGHT_SCREENSHOT_DIR set.");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: resolve(screenshots, "test-results"),
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

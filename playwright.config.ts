import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

/** The preview server port; set PLAYWRIGHT_PORT when 4173 is taken on a shared host. */
const port = Number(process.env.PLAYWRIGHT_PORT ?? "4173");
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
    baseURL: `http://127.0.0.1:${String(port)}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  // Chromium runs every test. WebKit runs only the tests tagged "@csp", because the CSP check
  // needs an engine that reports inline styles; a browser that is not installed fails the run.
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" }, grep: /@csp/ },
  ],
  webServer: {
    command: `pnpm preview --host 127.0.0.1 --port ${String(port)} --strictPort`,
    url: `http://127.0.0.1:${String(port)}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

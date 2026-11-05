// The settings screen is the one place to choose a data source (issue #53): every source has a card
// with its own action, "Forget what this browser remembers" asks first, and the page fits phone
// widths with 44 px controls, in every language and both themes. Synthetic data only. The "@csp"
// tag also runs these in WebKit.
// Screenshots: SETTINGS_SHOTS=<prefix> PLAYWRIGHT_SCREENSHOT_DIR=<dir> writes
// <prefix>-<locale>-<width>-<theme>.png.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { en, LOCALE_NAMES, LOCALES } from "../src/i18n/catalog";
import { ja } from "../src/i18n/ja";
import { zhTW } from "../src/i18n/zh-TW";

const catalogs = { en, ja, "zh-TW": zhTW } as const;
const WIDTHS = [360, 390, 430, 1280] as const;

async function openSettings(
  page: Page,
  locale: keyof typeof catalogs,
  width: number,
  theme: string,
) {
  await page.addInitScript(
    ({ code, value }) => {
      localStorage.setItem("agent-collab-viewer.locale", code);
      localStorage.setItem("agent-collab-viewer.theme", value);
    },
    { code: locale, value: theme },
  );
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: catalogs[locale]["welcome.openAnother"] }).click();
  await expect(page.locator("#github-form")).toBeVisible();
}

for (const locale of LOCALES) {
  for (const width of WIDTHS) {
    test(`settings lists every data source in ${LOCALE_NAMES[locale]} at ${String(width)} px @csp`, async ({
      page,
    }) => {
      const messages = catalogs[locale];
      await openSettings(page, locale, width, "paper");
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator(".data-sources h3")).toHaveText([
        messages["sources.githubTitle"],
        messages["sources.localTitle"],
        messages["sources.liveTitle"],
        messages["sources.offlineTitle"],
      ]);
      await expect(page.locator("#github-form")).toBeVisible();
      await expect(page.locator(".forget-all h2")).toHaveText(messages["forget.heading"]);

      // No horizontal overflow, and every control is at least 44 px tall.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      const small = await page.evaluate(
        () =>
          [...document.querySelectorAll(".data-sources, .forget-all")]
            .flatMap((section) => [...section.querySelectorAll("button, a")])
            .map((node) => node.getBoundingClientRect())
            .filter((box) => box.width > 0 && box.height < 44).length,
      );
      expect(small).toBe(0);
    });
  }
}

test("forgetting asks first, then says so, and the offline demo opens from settings @csp", async ({
  page,
}) => {
  await openSettings(page, "en", 390, "paper");
  await page.getByRole("button", { name: en["forget.button"] }).click();
  await expect(page.getByRole("button", { name: en["forget.confirm"] })).toBeVisible();
  await page.getByRole("button", { name: en["settings.cancel"] }).first().click();
  await expect(page.getByRole("button", { name: en["forget.confirm"] })).toHaveCount(0);

  await page.getByRole("button", { name: en["forget.button"] }).click();
  await page.getByRole("button", { name: en["forget.confirm"] }).click();
  await expect(page.getByRole("status")).toHaveText(en["forget.done"]);

  await page.getByRole("button", { name: en["settings.openOffline"] }).click();
  await expect(page.locator("h1")).toHaveText(en["app.demoTitle"]);
});

const prefix = process.env.SETTINGS_SHOTS;
test.describe("screenshots", () => {
  test.skip(prefix === undefined, "set SETTINGS_SHOTS to write screenshots");
  for (const locale of LOCALES) {
    for (const width of WIDTHS) {
      for (const theme of ["paper", "night-owl"]) {
        test(`${locale} ${String(width)} ${theme}`, async ({ page }) => {
          await openSettings(page, locale, width, theme);
          const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
          mkdirSync(directory, { recursive: true });
          await page.screenshot({
            path: join(directory, `${prefix ?? "shot"}-${locale}-${String(width)}-${theme}.png`),
            fullPage: true,
          });
        });
      }
    }
  }

  // The steps of forgetting, in Japanese on a 360 px phone.
  for (const step of ["confirm", "done", "failed"] as const) {
    test(`ja 360 forget ${step}`, async ({ page }) => {
      if (step === "failed") {
        // The browser-encrypted store cannot be opened, so removing credentials fails.
        await page.addInitScript(() => {
          Object.defineProperty(window, "indexedDB", {
            value: {
              open: () => {
                throw new Error("blocked");
              },
            },
          });
        });
      }
      await openSettings(page, "ja", 360, "paper");
      await page.getByRole("button", { name: ja["forget.button"] }).click();
      if (step !== "confirm")
        await page.getByRole("button", { name: ja["forget.confirm"] }).click();
      const note = step === "done" ? "forget.done" : "forget.failed";
      if (step !== "confirm") await expect(page.getByText(ja[note])).toBeVisible();
      await page.locator(".forget-all").scrollIntoViewIfNeeded();
      const directory = process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? "";
      mkdirSync(directory, { recursive: true });
      await page.locator(".forget-all").screenshot({
        path: join(directory, `${prefix ?? "shot"}-ja-360-forget-${step}.png`),
      });
    });
  }
});

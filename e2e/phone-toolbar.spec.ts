import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

async function measure(page: Page) {
  return page.locator(".bar").evaluate((bar) => {
    const actions = bar.querySelector(".bar-actions") as HTMLElement;
    const title = bar.querySelector("h1") as HTMLElement;
    const box = bar.getBoundingClientRect();
    const action = actions.getBoundingClientRect();
    const heading = title.getBoundingClientRect();
    const css = getComputedStyle(bar);
    return {
      right: box.right - action.right,
      left: action.left - box.left,
      titleLeft: heading.left - box.left,
      paddingLeft: parseFloat(css.paddingLeft),
      paddingRight: parseFloat(css.paddingRight),
    };
  });
}

async function expectBaselinePosition(page: Page) {
  const positions = await page.locator(".bar-actions").evaluate((actions) => {
    const css = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
    const nested = css.flatMap((rule) =>
      rule instanceof CSSGroupingRule ? [...rule.cssRules] : [rule],
    );
    const rule = nested.find(
      (candidate): candidate is CSSStyleRule =>
        candidate instanceof CSSStyleRule &&
        candidate.selectorText.includes("data-mobile-view") &&
        candidate.selectorText.includes(".bar-actions"),
    );
    const current = actions.getBoundingClientRect();
    const before = { left: current.left, right: current.right };
    if (rule === undefined) return { before, after: before };
    const value = rule.style.getPropertyValue("margin-left");
    rule.style.removeProperty("margin-left");
    const baseline = actions.getBoundingClientRect();
    const after = { left: baseline.left, right: baseline.right };
    rule.style.setProperty("margin-left", value);
    return { before, after };
  });
  expect(positions.before.left).toBeCloseTo(positions.after.left, 1);
  expect(positions.before.right).toBeCloseTo(positions.after.right, 1);
}

async function expectSplitHeader(page: Page) {
  const m = await measure(page);
  expect(Math.abs(m.right - m.paddingRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.titleLeft - m.paddingLeft)).toBeLessThanOrEqual(1);
}

for (const width of [360, 390, 1280]) {
  test(`toolbar alignment at ${String(width)}px @csp`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Open saved repository" })).toBeVisible();
    await expect(page.locator(".bar h1")).toBeVisible();
    await expectBaselinePosition(page);
    await page.getByRole("button", { name: "Open saved repository" }).click();
    await page.getByRole("button", { name: "Open offline demo" }).click();
    await expect(page.getByRole("heading", { name: "Demo repository" })).toBeVisible();
    await expect(page.locator(".bar h1")).toBeVisible();
    await expectBaselinePosition(page);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.locator(".conversation")).toBeVisible();
    const m = await measure(page);
    expect(Math.abs(m.right - m.paddingRight)).toBeLessThanOrEqual(1);
    expect(m.left).toBeGreaterThan(m.paddingLeft + 1);
    if (width === 1280) {
      await expectSplitHeader(page);
      await expectBaselinePosition(page);
    }
    const dir = process.env.TOOLBAR_SCREENSHOTS;
    if (dir !== undefined && browserName === "chromium" && width !== 1280) {
      await page
        .locator(".bar")
        .screenshot({ path: join(dir, `toolbar-${String(width)}-paper.png`) });
      await page.getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Use Night Owl theme" }).click();
      await page
        .locator(".bar")
        .screenshot({ path: join(dir, `toolbar-${String(width)}-night-owl.png`) });
    }
  });
}

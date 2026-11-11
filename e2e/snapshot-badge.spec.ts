// The snapshot badge and its freshness text sit right after the app title, not in the middle of
// the free space of the header. Synthetic demo snapshot only.
import { expect, test } from "@playwright/test";

import { en } from "../src/i18n/catalog";
import { topicSnapshot } from "../tests/topic-snapshot-fixture";

for (const view of [
  { label: "desktop", size: { width: 1280, height: 800 } },
  { label: "phone", size: { width: 390, height: 844 } },
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`the snapshot badge sits next to the title on ${view.label} in ${scheme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(view.size);
      const snapshot = await topicSnapshot();
      await page.route("**/demo-snapshot.json", (route) => route.fulfill({ json: snapshot }));
      await page.goto("/?demo");
      const label = page.locator(".source-label");
      const freshness = page.locator(".source-indicator .last-changed");
      await expect(label).toHaveText(en["bar.hostedSnapshot"]);
      await expect(freshness).toBeVisible();
      const [h1, badge, fresh] = await Promise.all([
        page.locator(".bar h1").boundingBox(),
        label.boundingBox(),
        freshness.boundingBox(),
      ]);
      if (h1 === null || badge === null || fresh === null) throw new Error("header not rendered");
      const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
      if (view.size.width > 720) {
        // On the title's line, right after it, not centered in the free space.
        const gap = badge.x - (h1.x + h1.width);
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThanOrEqual(20);
        // Same baseline: the text sits on the first line of the title, even when the title wraps.
        const firstLine = await page.locator(".bar h1").evaluate((heading) => {
          const range = document.createRange();
          range.selectNodeContents(heading);
          const line = range.getClientRects()[0];
          return line === undefined ? null : { y: line.y, height: line.height };
        });
        if (firstLine === null) throw new Error("title has no text");
        expect(Math.abs(middle(badge) - middle(firstLine))).toBeLessThanOrEqual(6);
        expect(Math.abs(middle(fresh) - middle(firstLine))).toBeLessThanOrEqual(6);
      } else {
        // On a phone the indicator keeps its own line below the title, from the left edge.
        expect(badge.y).toBeGreaterThanOrEqual(h1.y + h1.height);
        expect(badge.x).toBeLessThanOrEqual(h1.x + 2);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
    });
  }
}

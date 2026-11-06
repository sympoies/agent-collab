// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

describe("README UI previews", () => {
  it("references the generated images with alt text and names both themes in the caption", () => {
    const renderedHeights = [
      {
        path: "docs/assets/readme/desktop-night-owl-1280.png",
        dimensions: [1280, 900],
      },
      {
        path: "docs/assets/readme/phone-paper-390.png",
        dimensions: [390, 844],
      },
    ];
    const widths: number[] = [];
    const heights = renderedHeights.map(({ path, dimensions }) => {
      const image = [...readme.matchAll(/<img\b[^>]*>/g)].find((match) =>
        match[0].includes(`src="${path}"`),
      )?.[0];
      expect(image, `README image tag for ${path}`).toBeDefined();
      expect(image?.match(/\balt="([^"]*)"/)?.[1]?.trim()).toBeTruthy();
      const widthPercentage = Number(image?.match(/\bwidth="([\d.]+)%"/)?.[1]);
      expect(widthPercentage).toBeGreaterThan(0);
      widths.push(widthPercentage);

      const asset = resolve(root, path);
      expect(existsSync(asset), `generated preview ${path}`).toBe(true);
      const png = readFileSync(asset);
      expect(png.byteLength).toBeGreaterThan(0);
      const actualDimensions = [png.readUInt32BE(16), png.readUInt32BE(20)];
      expect(actualDimensions).toEqual(dimensions);
      return (
        (widthPercentage / 100 / (actualDimensions[0] as number)) * (actualDimensions[1] as number)
      );
    });

    const caption = readme.match(/\*UI preview[^*]*\*/)?.[0] ?? "";
    expect(caption).toContain("Night Owl");
    expect(caption).toContain("Paper");
    expect(caption).toContain("synthetic data");
    expect(readme).toMatch(/fictional data; run `pnpm previews` to regenerate them\./);
    expect(readme).toMatch(
      /Run `pnpm previews` to build the production viewer and regenerate the two README\s+screenshots from the bundled offline demo\./,
    );
    expect(widths.reduce((total, width) => total + width, 0)).toBeLessThanOrEqual(98);
    expect(Math.abs((heights[0] as number) - (heights[1] as number))).toBeLessThan(0.0001);
  });
});

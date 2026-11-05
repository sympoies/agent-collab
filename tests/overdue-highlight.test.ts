import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = read("../src/ui/shared/tokens.css");
const shared = read("../src/ui/shared/components.css");
const styles = read("../src/ui/styles.css");

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
}

/** The token values of one theme block, hex only. */
function theme(selector: string): Map<string, string> {
  const start = tokens.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = tokens.slice(tokens.indexOf("{", start) + 1, tokens.indexOf("}", start));
  return new Map(
    [...body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(([, name, value]) => [
      name ?? "",
      value ?? "",
    ]),
  );
}

type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
const over = (front: Rgb, back: Rgb, alpha: number): Rgb =>
  front.map((value, i) => value * alpha + (back[i] ?? 0) * (1 - alpha)) as unknown as Rgb;
function luminance([red, green, blue]: Rgb): number {
  const linear = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}
function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

describe("the shared overdue highlight", () => {
  const highlight = rule(shared, ".shared-overdue");

  it("is error-coloured text on a low-opacity tint of the error colour, without an underline", () => {
    expect(highlight).toMatch(/color:\s*var\(--error\)/);
    expect(highlight).toMatch(
      /background:\s*color-mix\(in srgb,\s*var\(--error\)\s*\d+%,\s*transparent\)/,
    );
    expect(highlight).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(highlight).toMatch(/text-decoration:\s*none/);
    // The meaning does not rely on colour alone.
    expect(shared).toMatch(/\.shared-overdue::before\s*\{[^}]*content:\s*"! "/);
  });

  it("uses a tint of 12 to 16 percent", () => {
    const percent = Number(/var\(--error\)\s*(\d+)%/.exec(highlight)?.[1]);
    expect(percent).toBeGreaterThanOrEqual(12);
    expect(percent).toBeLessThanOrEqual(16);
  });

  const themes = [
    [":root {", "the default (Paper) palette"],
    [':root[data-theme="paper"]', "forced Paper"],
    [':root[data-theme="night-owl"]', "forced Night Owl"],
    [":root:not([data-theme])", "automatic dark"],
  ] as const;
  for (const [selector, name] of themes) {
    it(`keeps 4.5:1 between the text and the tinted background on every surface in ${name}`, () => {
      const values = theme(selector);
      const percent = Number(/var\(--error\)\s*(\d+)%/.exec(highlight)?.[1]) / 100;
      const error = rgb(values.get("--error") ?? "");
      // The surfaces a due line sits on: cards and the page; the floating popover is not one.
      for (const surface of ["--card", "--canvas", "--inset"]) {
        const background = over(error, rgb(values.get(surface) ?? ""), percent);
        expect(contrast(error, background), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("replaces the old duplicated rules", () => {
    expect(styles).not.toMatch(/\.due\[data-overdue/);
    expect(shared).not.toMatch(/\.question-due\[data-overdue/);
    expect(shared).not.toMatch(/\.question-overdue/);
  });
});

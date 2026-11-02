import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");

function declarations(theme: "night-owl" | "paper"): Map<string, string> {
  const selector = `:root[data-theme="${theme}"]`;
  const start = css.indexOf(selector);
  expect(start, `${selector} theme tokens`).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", start);
  const bodyEnd = css.indexOf("}", bodyStart);
  const body = css.slice(bodyStart + 1, bodyEnd);
  return new Map(
    [...body.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map(([, name, value]) => [
      name ?? "",
      value ?? "",
    ]),
  );
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

describe("theme text contrast", () => {
  for (const theme of ["night-owl", "paper"] as const) {
    it(`${theme} keeps each text token at WCAG AA on its named surfaces`, () => {
      const tokens = declarations(theme);
      const surfaces = ["--canvas", "--card", "--toolbar", "--floating", "--inset", "--code"];
      const foregrounds = [
        "--text",
        "--secondary",
        "--muted",
        "--accent",
        "--ok",
        "--warn",
        "--error",
        "--cyan",
        "--purple",
      ];

      for (const foreground of foregrounds) {
        for (const background of surfaces) {
          expect(
            contrast(tokens.get(foreground) ?? "", tokens.get(background) ?? ""),
            `${theme} ${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      for (const pair of [
        ["--bubble-other-text", "--bubble-other"],
        ["--bubble-own-text", "--bubble-own"],
        ["--muted", "--bubble-other"],
        ["--muted", "--bubble-own"],
        ["--secondary", "--bubble-other"],
        ["--secondary", "--bubble-own"],
        ["--accent", "--bubble-other"],
        ["--accent", "--bubble-own"],
        ["--warn", "--bubble-other"],
        ["--warn", "--bubble-own"],
        ["--error", "--bubble-other"],
        ["--error", "--bubble-own"],
      ]) {
        const [foreground, background] = pair;
        expect(
          contrast(tokens.get(foreground ?? "") ?? "", tokens.get(background ?? "") ?? ""),
          `${theme} ${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

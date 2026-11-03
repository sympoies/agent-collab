import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PALETTE_SIZE } from "../src/identity/preferences";

const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");

type Channels = {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
};

function tokensOf(selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  expect(start, `${selector} tokens`).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", start);
  const bodyEnd = css.indexOf("}", bodyStart);
  const body = css.slice(bodyStart + 1, bodyEnd);
  return new Map(
    [...body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6}|rgba?\([^)]+\))/g)].map(
      ([, name, value]) => [name ?? "", value ?? ""],
    ),
  );
}

function declarations(theme: "night-owl" | "paper"): Map<string, string> {
  return tokensOf(`:root[data-theme="${theme}"]`);
}

function channels(value: string): Channels {
  if (value.startsWith("#")) {
    return {
      red: Number.parseInt(value.slice(1, 3), 16),
      green: Number.parseInt(value.slice(3, 5), 16),
      blue: Number.parseInt(value.slice(5, 7), 16),
      alpha: 1,
    };
  }
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/.exec(value);
  if (match === null) throw new Error(`Unsupported contrast color: ${value}`);
  return {
    red: Number(match[1]),
    green: Number(match[2]),
    blue: Number(match[3]),
    alpha: Number(match[4] ?? "1"),
  };
}

function composite(foreground: string, background: string, opacity = 1): string {
  const front = channels(foreground);
  const back = channels(background);
  const alpha = front.alpha * opacity;
  const mix = (value: number, under: number) => Math.round(value * alpha + under * (1 - alpha));
  return `#${[mix(front.red, back.red), mix(front.green, back.green), mix(front.blue, back.blue)]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function luminance(value: string): number {
  const { red, green, blue } = channels(value);
  const linear = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

function disabledButtonRule(): string {
  const rule = css.match(/button:disabled\s*\{([^}]*)\}/);
  if (rule === null) throw new Error("Missing button:disabled CSS rule.");
  return rule[1] ?? "";
}

describe("theme text contrast", () => {
  it("repeats the Paper palette as the default and Night Owl as the dark system default", () => {
    // Pages without a saved theme use these copies; they must not drift from the named themes.
    expect(Object.fromEntries(tokensOf(":root {"))).toEqual(
      Object.fromEntries(declarations("paper")),
    );
    expect(Object.fromEntries(tokensOf(":root:not([data-theme])"))).toEqual(
      Object.fromEntries(declarations("night-owl")),
    );
  });

  it("uses the supplied Paper e-paper palette and surface roles", () => {
    const tokens = declarations("paper");
    expect(Object.fromEntries(tokens)).toMatchObject({
      "--canvas": "#f4f3ed",
      "--card": "#ffffff",
      "--toolbar": "#ecefe8",
      "--border": "rgba(31, 37, 32, 0.22)",
      "--text": "#1f2520",
      "--muted": "#5d645c",
      "--accent": "#2457a7",
      "--link": "#0c655b",
      "--ok": "#2d6c3f",
      "--warm-note": "#73520f",
      "--warn": "#855b00",
      "--error": "#a43c2e",
      "--cyan": "#0b7c8c",
      "--purple": "#5c4b86",
      "--grid": "#d6d9cf",
      "--chip-bg": "rgba(31, 37, 32, 0.06)",
      "--chip-border": "rgba(31, 37, 32, 0.22)",
      "--hover": "rgba(31, 37, 32, 0.06)",
      "--hover-strong": "rgba(31, 37, 32, 0.09)",
      "--on-person": "#ffffff",
      "--person-0": "#af4e1c",
      "--person-1": "#2d6c3f",
      "--person-2": "#6d4aa8",
      "--person-3": "#2457a7",
      "--person-4": "#0a7685",
      "--person-5": "#a43c2e",
      "--person-6": "#855b00",
      "--person-7": "#596b79",
    });
    expect(css).toContain("--popover-shadow: 0 8px 18px rgba(31, 37, 32, 0.18);");
  });

  it("retains the Night Owl palette from issue #9", () => {
    const tokens = declarations("night-owl");
    expect(Object.fromEntries(tokens)).toMatchObject({
      "--canvas": "#011627",
      "--card": "#061e31",
      "--toolbar": "#0b2942",
      "--floating": "#123650",
      "--inset": "#00111f",
      "--text": "#d6deeb",
      "--secondary": "#a8bdd4",
      "--muted": "#8ba1b8",
      "--accent": "#82aaff",
      "--ok": "#22da6e",
      "--warn": "#ffcb8b",
      "--error": "#ef5350",
      "--cyan": "#7fdbca",
      "--purple": "#c792ea",
      "--on-person": "#011627",
      "--person-0": "#f78c6c",
      "--person-1": "#addb67",
      "--person-2": "#c792ea",
      "--person-3": "#82aaff",
      "--person-4": "#7fdbca",
      "--person-5": "#ef5350",
      "--person-6": "#ffcb8b",
      "--person-7": "#8ba1b8",
    });
    expect(channels(tokens.get("--border") ?? "")).toMatchObject({ alpha: 0.4 });
    expect(channels(tokens.get("--border-soft") ?? "")).toMatchObject({ alpha: 0.2 });
    expect(channels(tokens.get("--border-strong") ?? "")).toMatchObject({ alpha: 0.62 });
  });

  for (const theme of ["night-owl", "paper"] as const) {
    it(`${theme} keeps rendered text at WCAG AA on its actual surfaces`, () => {
      const tokens = declarations(theme);
      const pairs: readonly [string, string][] = [
        ["--text", "--canvas"],
        ["--text", "--card"],
        ["--text", "--toolbar"],
        ["--text", "--floating"],
        ["--text", "--inset"],
        ["--text", "--code"],
        ["--secondary", "--card"],
        ["--secondary", "--toolbar"],
        ["--warm-note", "--toolbar"],
        ["--muted", "--canvas"],
        ["--muted", "--card"],
        ["--muted", "--toolbar"],
        ["--muted", "--inset"],
        ["--secondary", "--code"],
        ["--link", "--code"],
        ["--link", "--card"],
        ["--text", "--code"],
        ["--accent", "--card"],
        ["--accent", "--floating"],
        ["--warn", "--canvas"],
        ["--warm-note", "--canvas"],
        ["--error", "--canvas"],
      ];

      for (const [foreground, background] of pairs) {
        expect(
          contrast(tokens.get(foreground) ?? "", tokens.get(background) ?? ""),
          `${theme} ${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      for (const hover of ["--hover", "--hover-strong"] as const) {
        const parentSurfaces =
          hover === "--hover" ? ["--canvas", "--toolbar", "--inset"] : ["--inset"];
        for (const parent of parentSurfaces) {
          const renderedHover = composite(tokens.get(hover) ?? "", tokens.get(parent) ?? "");
          const foregrounds =
            hover === "--hover"
              ? (["--text", "--muted", "--accent"] as const)
              : (["--text", "--accent"] as const);
          for (const foreground of foregrounds) {
            expect(
              contrast(tokens.get(foreground) ?? "", renderedHover),
              `${theme} ${foreground} on ${hover} composited over ${parent}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      }

      // The viewer's highlighted rows paint --selected over the conversation surface.
      const highlighted = composite(tokens.get("--selected") ?? "", tokens.get("--card") ?? "");
      for (const foreground of ["--text", "--secondary", "--muted", "--accent"] as const) {
        expect(
          contrast(tokens.get(foreground) ?? "", highlighted),
          `${theme} ${foreground} on a highlighted message`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const surface of [tokens.get("--card") ?? "", highlighted]) {
        const chip = composite(tokens.get("--chip-bg") ?? "", surface);
        for (const foreground of ["--text", "--link"] as const) {
          expect(
            contrast(tokens.get(foreground) ?? "", chip),
            `${theme} ${foreground} on a chip over ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${theme} person colors reach WCAG AA as names on the canvas, conversation and profile panel and under avatar text`, () => {
      const tokens = declarations(theme);
      for (let slot = 0; slot < PALETTE_SIZE; slot += 1) {
        const person = tokens.get(`--person-${String(slot)}`) ?? "";
        expect(person, `${theme} --person-${String(slot)}`).not.toBe("");
        for (const surface of ["--canvas", "--card", "--inset"] as const) {
          expect(
            contrast(person, tokens.get(surface) ?? ""),
            `${theme} --person-${String(slot)} name on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        expect(
          contrast(tokens.get("--on-person") ?? "", person),
          `${theme} avatar text on --person-${String(slot)}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(tokens.has(`--person-${String(PALETTE_SIZE)}`), "slots match PALETTE_SIZE").toBe(
        false,
      );
    });

    it(`${theme} keeps disabled-button text at WCAG AA after compositing`, () => {
      const tokens = declarations(theme);
      const rule = disabledButtonRule();
      const foreground = rule.match(/color:\s*var\((--[a-z-]+)\)/)?.[1] ?? "--text";
      const background = rule.match(/background:\s*var\((--[a-z-]+)\)/)?.[1] ?? "--card";
      const opacity = Number(rule.match(/opacity:\s*([0-9.]+)/)?.[1] ?? "1");
      const surface = tokens.get("--toolbar") ?? "";
      const renderedText = composite(tokens.get(foreground) ?? "", surface, opacity);
      const renderedBackground = composite(tokens.get(background) ?? "", surface, opacity);

      expect(
        contrast(renderedText, renderedBackground),
        `${theme} disabled ${foreground} on ${background} composited over --toolbar at ${opacity}`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

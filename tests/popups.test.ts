import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { POPUPS } from "../src/ui/popups";

// Floating controls that are not popups: fixed to a corner of the viewport, so nothing opens from
// a trigger and nothing can leave the screen.
const FLOATING_CONTROLS = [".jump-to-latest"];

/** Whether a declaration lifts the element with a drop shadow (a blurred layer or a filter). */
function liftsWithShadow(body: string): boolean {
  if (/filter:[^;]*drop-shadow\(/.test(body)) return true;
  const shadow = /box-shadow:\s*([^;]+)/.exec(body)?.[1];
  if (shadow === undefined) return false;
  // Layers are separated by commas outside parentheses. A focus ring (no blur: "0 0 0 2px") and
  // an inset highlight are not drop shadows, but one blurred layer among them is.
  const layers = shadow.split(/,(?![^(]*\))/).map((layer) => layer.trim());
  return layers.some((layer) => !/^inset\b/.test(layer) && !/^0 0 0 /.test(layer));
}

// A new popup joins `src/ui/popups.ts`; e2e/popups.spec.ts then checks it at phone widths. The
// guard finds popups by their shadow: a popup with no shadow at all would not be detected.
describe("the popup list", () => {
  it("names every stylesheet rule that lifts an element with a drop shadow", () => {
    const css = readFileSync(`${process.cwd()}/src/ui/styles.css`, "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const popups = new Set<string>();
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selectors = "", body = ""] = rule;
      if (!liftsWithShadow(body)) continue;
      for (const selector of selectors.split(",")) popups.add(selector.trim());
    }
    for (const control of FLOATING_CONTROLS) popups.delete(control);
    expect([...popups].sort()).toEqual(POPUPS.map((popup) => popup.selector).sort());
  });

  it("sees filter shadows and blurred layers after a ring, and skips rings and inset highlights", () => {
    expect(liftsWithShadow("filter: drop-shadow(0 2px 4px #000);")).toBe(true);
    expect(liftsWithShadow("box-shadow: 0 0 0 1px red, 0 8px 18px rgba(0, 0, 0, 0.3);")).toBe(true);
    expect(liftsWithShadow("box-shadow: 0 0 0 2px var(--accent);")).toBe(false);
    expect(liftsWithShadow("box-shadow: inset 0 0 0 1px red;")).toBe(false);
    expect(liftsWithShadow("color: red;")).toBe(false);
  });
});

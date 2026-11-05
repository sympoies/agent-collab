import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { POPUPS } from "../src/ui/popups";

// Floating controls that are not popups: fixed to a corner of the viewport, so nothing opens from
// a trigger and nothing can leave the screen.
const FLOATING_CONTROLS = [".jump-to-latest"];

// A new popup joins `src/ui/popups.ts`; e2e/popups.spec.ts then checks it at phone widths.
describe("the popup list", () => {
  it("names every stylesheet rule that lifts an element with a drop shadow", () => {
    const css = readFileSync(`${process.cwd()}/src/ui/styles.css`, "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const popups = new Set<string>();
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selectors = "", body = ""] = rule;
      // A drop shadow, not a focus ring (no blur) or an inset highlight.
      if (!/box-shadow:\s*(?=\S)(?!0 0 0 |inset)/.test(body)) continue;
      for (const selector of selectors.split(",")) popups.add(selector.trim());
    }
    for (const control of FLOATING_CONTROLS) popups.delete(control);
    expect([...popups].sort()).toEqual(POPUPS.map((popup) => popup.selector).sort());
  });
});

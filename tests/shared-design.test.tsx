import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ParticipantIdentity, StatusChip, TopicChip } from "../src/ui/shared/components";
import { buildPeople } from "../src/ui/people";
import { EMPTY_PREFERENCES } from "../src/identity/preferences";

const uiRoot = resolve(import.meta.dirname, "../src/ui");
const colorLiteral =
  /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(|\b(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgray|darkgreen|darkgrey|darkmagenta|darkorange|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)\b/i;

function stylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
  });
}

describe("shared design layer", () => {
  const people = buildPeople(["alice-agent", "bob-agent"], EMPTY_PREFERENCES);

  it("renders the participant with the same palette slot used by chat", () => {
    const html = renderToStaticMarkup(
      <ParticipantIdentity name="alice-agent" people={people} avatar />,
    );
    expect(html).toContain(`data-slot="${String(people.slot("alice-agent"))}"`);
    expect(html).toContain("alice-agent");
    expect(html).toContain("A");
  });

  it("renders the shared topic label and semantic status variants", () => {
    expect(renderToStaticMarkup(<TopicChip topic="api" />)).toContain(">#api</span>");
    for (const tone of ["attention", "success", "danger", "neutral"] as const) {
      expect(renderToStaticMarkup(<StatusChip tone={tone}>Status</StatusChip>)).toContain(
        `data-tone="${tone}"`,
      );
    }
  });

  it("keeps raw colors and font sizes inside the shared token layer", () => {
    const violations: string[] = [];
    for (const path of stylesheets(uiRoot)) {
      if (relative(uiRoot, path) === "shared/tokens.css") continue;
      const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const declarations = [...css.matchAll(/(?:^|[;{])\s*([\w-]+)\s*:\s*([^;{}]+)/gim)];
      const colorProperties =
        /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke)$/i;
      const resetValue = /\b(?:none|transparent|inherit|initial|unset|currentcolor)\b|^\s*0\s*$/i;
      const rawColors = declarations.filter(([, property, value]) => {
        if (colorLiteral.test(value ?? "")) return true;
        return (
          colorProperties.test(property ?? "") &&
          !/\bvar\(/i.test(value ?? "") &&
          !resetValue.test(value ?? "")
        );
      });
      const rawFontSizes = declarations.filter(
        ([, property, value]) =>
          /^(?:font-size|font)$/i.test(property ?? "") &&
          /\b[\d.]+(?:px|em|rem|%|pt)\b/i.test(value ?? ""),
      );
      if (rawColors.length > 0 || rawFontSizes.length > 0) {
        violations.push(
          `${relative(uiRoot, path)}: raw colors [${rawColors.map(([, property, value]) => `${property ?? ""}: ${(value ?? "").trim()}`).join("; ")}], raw font sizes [${rawFontSizes.map(([, property, value]) => `${property ?? ""}: ${(value ?? "").trim()}`).join("; ")}]`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});

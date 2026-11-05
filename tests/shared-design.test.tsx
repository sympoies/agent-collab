import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ParticipantIdentity, StatusChip, TopicChip } from "../src/ui/shared/components";
import { buildPeople } from "../src/ui/people";
import { EMPTY_PREFERENCES } from "../src/identity/preferences";

const uiRoot = resolve(import.meta.dirname, "../src/ui");

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
      const rawColors = [...css.matchAll(/(?:^|[;\s{])[-a-z]+\s*:[^;{}]*#[\da-f]{3,8}\b/gim)];
      const rawFontSizes = [
        ...css.matchAll(/font-size\s*:\s*(?!var\()[\d.]+(?:px|em|rem|%|pt)\b/gim),
      ];
      if (rawColors.length > 0 || rawFontSizes.length > 0) {
        violations.push(
          `${relative(uiRoot, path)}: ${rawColors.length} raw color(s), ${rawFontSizes.length} raw font size(s)`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});

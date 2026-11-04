// @vitest-environment happy-dom

// The production page ships a strict Content Security Policy without `style-src`, and some
// browsers report inline `style` attributes as violations. No component may emit one: colors come
// from classes and data attributes defined in the stylesheet.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { PALETTE_SIZE } from "../src/identity/preferences";
import { Loader } from "../src/loader/loader";
import { DEFAULT_DRAFT } from "../src/settings/model";
import { FixtureSource } from "../src/source/fixture";
import { App } from "../src/ui/App";
import { SettingsView } from "../src/ui/SettingsView";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Vitest runs from the repository root; import.meta.url is not a file URL in happy-dom.
const ROOT = `${process.cwd()}/`;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Places in the source that set an inline style: the JSX attribute, a `style` key or property. */
function styleUses(path: string): string[] {
  const file = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const named =
      (ts.isJsxAttribute(node) && node.name.getText(file) === "style") ||
      (ts.isPropertyAssignment(node) && node.name.getText(file) === "style") ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "style") ||
      (ts.isStringLiteralLike(node) && node.text === "style") ||
      (ts.isImportSpecifier(node) && node.name.text === "CSSProperties");
    if (named) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      found.push(`${path.slice(ROOT.length)}:${String(line)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("no inline style attributes", () => {
  it("no source file sets a style attribute, property or CSSProperties value", () => {
    const uses = sourceFiles(join(ROOT, "src")).flatMap(styleUses);
    expect(uses).toEqual([]);
  });

  it("the stylesheet maps every palette slot to its theme-aware color", () => {
    const css = readFileSync(join(ROOT, "src/ui/styles.css"), "utf8");
    for (let slot = 0; slot < PALETTE_SIZE; slot++) {
      const id = String(slot);
      expect(css, `slot ${id}`).toMatch(
        new RegExp(`\\[data-slot="${id}"\\]\\s*\\{\\s*--person: var\\(--person-${id}\\);\\s*\\}`),
      );
    }
  });

  const A = "2026-10-01T0900-alice-agent-api-01";
  const B = "2026-10-01T0930-bob-agent-api-01";
  const files = {
    ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n",
    [`inbox/${A}.md`]: messageText(A, "alice-agent", "api", {
      to: "bob-agent",
      type: "question",
      refs: "topics/api/data.csv",
    }),
    [`inbox/${B}.md`]: messageText(B, "bob-agent", "api", { reply_to: A, type: "answer" }),
    "topics/api/data.csv": "a,b\n1,2\n",
  };

  let mounted: { host: HTMLElement; root: Root } | null = null;
  afterEach(() => {
    if (mounted !== null) {
      const { root } = mounted;
      act(() => {
        root.unmount();
      });
    }
    mounted = null;
    document.body.replaceChildren();
  });

  const press = async (host: HTMLElement, label: string) => {
    const target = [...host.querySelectorAll("button")].find((candidate) =>
      candidate.textContent.startsWith(label),
    );
    expect(target, label).toBeDefined();
    await act(async () => {
      target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it("the viewer, its people colors, questions, files and profile panel render without one", async () => {
    const loader = new Loader(new FixtureSource(files));
    await loader.open();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={loader}
            title="Repo"
            selfNames={new Set(["alice-agent"])}
            identity={{ storage: null, key: "test" }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    const inline: Record<string, number> = {};
    const check = (screen: string) => {
      inline[screen] = host.querySelectorAll("[style]").length;
    };
    check("chat");
    // The people are still colored, through a slot the stylesheet maps to a palette color.
    const slots = [...host.querySelectorAll(".group")].map((group) =>
      group.getAttribute("data-slot"),
    );
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => /^[0-7]$/.test(slot ?? ""))).toBe(true);
    await press(host, "Profile & colors");
    check("profile");
    expect(host.querySelectorAll(".profile-who[data-slot]").length).toBeGreaterThan(0);
    expect(host.querySelectorAll(".swatch[data-slot]").length).toBeGreaterThanOrEqual(8);
    for (const label of ["Questions", "Files"]) {
      await press(host, label);
      check(label);
    }
    expect(inline).toEqual({ chat: 0, profile: 0, Questions: 0, Files: 0 });
  });

  it("the settings screen renders without one", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        initial={{ ...DEFAULT_DRAFT, repository: "alice-org/collab" }}
        storedEndpoints={{ memory: null, "browser-encrypted": null }}
        onSave={() => Promise.resolve(null)}
        onRemoveCredentials={() => Promise.resolve()}
        onCancel={null}
        onOpenDemo={() => undefined}
        onOpenLiveDemo={() => undefined}
      />,
    );
    expect(html).not.toMatch(/\sstyle=/);
  });
});

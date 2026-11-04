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
  return styleUsesIn(path, readFileSync(path, "utf8"));
}

function styleUsesIn(path: string, text: string): string[] {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const named =
      (ts.isJsxAttribute(node) && node.name.getText(file) === "style") ||
      (ts.isPropertyAssignment(node) && node.name.getText(file) === "style") ||
      (ts.isShorthandPropertyAssignment(node) && node.name.text === "style") ||
      (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === "style") ||
      (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === "style") ||
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

  it("the scan recognises each way of writing an inline style", () => {
    const find = (code: string) => styleUsesIn("x.tsx", code).length;
    expect(find("const a = <p style={x} />;")).toBe(1);
    expect(find("const a = { style };")).toBe(1);
    expect(find("const { style } = props;")).toBe(1);
    expect(find("function f({ style }: P) {}")).toBe(1);
    expect(find("el.style.color = 'red';")).toBe(1);
    expect(find("const a = { style: x };")).toBe(1);
    expect(find("const a = <p className='x' />;")).toBe(0);
  });

  it("index.html and the public files carry no style attribute or style element", () => {
    const pages = [
      join(ROOT, "index.html"),
      ...readdirSync(join(ROOT, "public")).map((name) => join(ROOT, "public", name)),
    ];
    for (const page of pages) {
      const text = readFileSync(page, "utf8");
      expect(text, page).not.toMatch(
        /<style[\s>]|\sstyle\s*=|\.style\b|setAttribute\(\s*["']style/,
      );
    }
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

  it("more people than palette slots wrap around and still use slots, and receipts and an opened preview have no style", async () => {
    const people = Array.from({ length: 10 }, (_, index) => `agent-${String(index)}`);
    const ids = people.map(
      (person, index) => `2026-10-02T09${String(index).padStart(2, "0")}-${person}-api-01`,
    );
    const received: Record<string, string> = {
      ".agent-collab": `collab-protocol: 1\nparticipants: ${people.join(", ")}\n`,
      "topics/api/data.csv": "a,b\n1,2\n",
    };
    people.forEach((person, index) => {
      const id = ids[index] ?? "";
      const fields: Record<string, string> =
        index === 0
          ? { to: "agent-1", type: "question", refs: "topics/api/data.csv" }
          : index === 1
            ? { to: "agent-0", type: "ack", reply_to: ids[0] ?? "" }
            : { to: "agent-0" };
      received[`inbox/${id}.md`] = messageText(id, person, "api", fields);
    });
    const loader = new Loader(new FixtureSource(received));
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
            selfNames={new Set(["agent-0"])}
            identity={{ storage: null, key: "wrap" }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    const slots = [...host.querySelectorAll(".group")].map((group) =>
      group.getAttribute("data-slot"),
    );
    expect(slots).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "0", "1"]);
    const card = host.querySelector<HTMLDetailsElement>("details.file-card");
    await act(async () => {
      if (card !== null) card.open = true;
      card?.dispatchEvent(new Event("toggle"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector(".csv-preview")).not.toBeNull();
    expect(host.querySelectorAll("[style]")).toHaveLength(0);
    await press(host, "Questions");
    expect(host.querySelector(".question-group, .questions")).not.toBeNull();
    expect(host.querySelectorAll("[style]")).toHaveLength(0);
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

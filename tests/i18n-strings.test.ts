// Fails when user-visible text is hard-coded outside the catalog: JSX text, text-like JSX
// attributes and prose-like string literals. Add the text to src/i18n instead (docs/i18n.md).
//
// What counts as prose: a literal with letters that has more than one word, or one word that starts
// with a capital ("Loading", "OK"). A lowercase single word is treated as an identifier or token
// ("memory", "github") and is not flagged. Text passed to Error constructors, loggers, DOM lookups
// and storage keys is developer-facing and skipped; the callee must match exactly.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;

/** Everything under src except the catalog itself and the places where English is intended. */
const SCANNED = ["src"];
const EXCLUDED = [
  "src/i18n", // the catalog
  "src/demo", // fixture repository content, shown as repository data
  "src/message", // the parser's technical diagnostics (docs/i18n.md)
  "src/source", // developer-facing error texts and HTTP tokens; the UI words errors from kind and code
  "src/credentials", // cryptography labels and redaction markers, never shown
];

/** Proper names and symbols that read the same in every language: "file: text". */
const ALLOWED = new Set<string>([
  // File format abbreviations on attachment cards, the same in every language.
  "src/ui/Attachments.tsx: MD",
  "src/ui/Attachments.tsx: TXT",
  "src/ui/Attachments.tsx: CSV",
  "src/ui/Attachments.tsx: IMG",
  // CSS tokens: the icon button class list and the phone media query.
  "src/ui/IconButton.tsx: icon-button #",
  "src/ui/Toolbar.tsx: (max-width: 720px)",
  // The error class name and the protocol token the marker file must start with.
  "src/loader/loader.ts: SetupError",
  "src/loader/loader.ts: collab-protocol: 1",
]);

const TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "aria-placeholder",
  "title",
  "placeholder",
  "alt",
  "label",
]);

const DEVELOPER_CALLEE =
  /^(new )?(Error|SourceError|SetupError|TypeError|RangeError)$|^console\.(log|info|warn|error|debug)$|^(document|window)\.(querySelector|querySelectorAll|getElementById|createElement|addEventListener|removeEventListener|matchMedia)$|^[\w.]+\.(getItem|setItem|removeItem|querySelector|querySelectorAll|addEventListener|removeEventListener|matchMedia)$|^(Reflect|Object|JSON)\.\w+$/;

const hasWords = (text: string) => /[A-Za-z]{2,}/.test(text);

function looksLikeText(text: string): boolean {
  if (!hasWords(text)) return false;
  if (/\s/.test(text.trim())) return true;
  return /^[A-Z][A-Za-z]+/.test(text.trim());
}

/** Hard-coded user-visible text in `code`, as "file:line  text", minus `allowed` entries. */
export function findHardCodedText(
  code: string,
  path: string,
  allowed: ReadonlySet<string> = ALLOWED,
): string[] {
  const source = ts.createSourceFile(
    path,
    code,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const problems: string[] = [];
  const report = (node: ts.Node, text: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    const shown = text.replace(/\s+/g, " ").trim();
    if (!allowed.has(`${path}: ${shown}`)) problems.push(`${path}:${String(line + 1)}  ${shown}`);
  };

  /** Whether a literal can reach the user: not an import path, key, comparison or developer text. */
  const isProse = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return false;
    if (ts.isJsxAttribute(parent)) return false; // text-like attributes are checked separately
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isElementAccessExpression(parent) || ts.isCaseClause(parent)) return false;
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        return false;
      }
    }
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const callee = `${ts.isNewExpression(parent) ? "new " : ""}${parent.expression.getText(source)}`;
      if (DEVELOPER_CALLEE.test(callee)) return false;
    }
    return true;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (hasWords(node.text)) report(node, node.text);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      const value = node.initializer;
      if (TEXT_ATTRIBUTES.has(name) && value !== undefined && ts.isStringLiteral(value)) {
        if (hasWords(value.text)) report(value, value.text);
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      isProse(node)
    ) {
      if (looksLikeText(node.text)) report(node, node.text);
    } else if (ts.isTemplateExpression(node) && isProse(node)) {
      const text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(
        "#",
      );
      if (looksLikeText(text)) report(node, text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return problems;
}

function files(path: string): string[] {
  if (EXCLUDED.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) return [];
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return /\.tsx?$/.test(path) ? [path] : [];
  return readdirSync(full).flatMap((entry) => files(join(path, entry)));
}

describe("user-visible text lives in the catalog", () => {
  it("has no hard-coded UI strings in the source tree", () => {
    const all = SCANNED.flatMap(files).flatMap((path) =>
      findHardCodedText(readFileSync(join(ROOT, path), "utf8"), path),
    );
    expect(all, `Move these into src/i18n (see docs/i18n.md):\n${all.join("\n")}`).toEqual([]);
  });
});

describe("the scanner", () => {
  const scan = (code: string, allowed?: ReadonlySet<string>) =>
    findHardCodedText(code, "x.tsx", allowed).map((line) => line.split("  ")[1]);

  it("flags JSX text, text attributes and prose-like literals", () => {
    expect(scan("const a = <p>Hello there</p>;")).toEqual(["Hello there"]);
    expect(scan('const a = <b aria-label="Close" />;')).toEqual(["Close"]);
    expect(scan('const a = <b aria-description="Closes it" />;')).toEqual(["Closes it"]);
    expect(scan('const a = <b aria-roledescription="slide" />;')).toEqual(["slide"]);
    expect(scan('const a = <b aria-valuetext="half way" />;')).toEqual(["half way"]);
    expect(scan('const a = <input placeholder="owner/repository" title="Name" />;')).toEqual([
      "owner/repository",
      "Name",
    ]);
    expect(scan('const a = format("Not available");')).toEqual(["Not available"]);
    expect(scan("const a = `Showing ${n} items`;")).toEqual(["Showing # items"]);
  });

  it("flags a lone capitalised word such as Loading or OK, but not a lowercase token", () => {
    expect(scan('const a = "Loading";')).toEqual(["Loading"]);
    expect(scan('const a = "OK";')).toEqual(["OK"]);
    expect(scan('const a = "memory"; const b = "browser-encrypted"; const c = "github";')).toEqual(
      [],
    );
  });

  it("skips developer-facing text only for the exact callee", () => {
    expect(scan('throw new Error("Something broke here");')).toEqual([]);
    expect(scan('console.error("Something broke here");')).toEqual([]);
    expect(scan('storage.getItem("Some Key Here");')).toEqual([]);
    expect(scan('formatNumber("Not available");')).toEqual(["Not available"]);
    expect(scan('myError("Not available");')).toEqual(["Not available"]);
    expect(scan('console.errors("Not available");')).toEqual(["Not available"]);
  });

  it("skips imports, keys, comparisons and case labels", () => {
    expect(
      scan(
        'import x from "../Some Path"; const o = { "Some Key": 1 }; if (a === "Some Value") {} switch (a) { case "Some Case": break; }',
      ),
    ).toEqual([]);
  });

  it("honours an allow-list entry for a proper name, and only that exact text", () => {
    const allowed = new Set(["x.tsx: GitHub"]);
    expect(scan("const a = <span>GitHub</span>;", allowed)).toEqual([]);
    expect(scan("const a = <span>GitHub Pages</span>;", allowed)).toEqual(["GitHub Pages"]);
    expect(scan("const a = <span>GitHub</span>;")).toEqual(["GitHub"]);
  });
});

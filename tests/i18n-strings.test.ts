// Fails when user-visible text is hard-coded outside the catalog: JSX text, text-like JSX
// attributes and prose-like string literals in the UI layer. Add the text to src/i18n instead.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
/** The UI layer: components, the composition root and the code that builds notices for them. */
const SCANNED = ["src/ui", "src/main.tsx", "src/settings/live-demo.ts"];
const TEXT_ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt", "label"]);
/** Proper names and symbols that are the same in every language. */
const ALLOWED = new Set<string>([]);

function files(path: string): string[] {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return [path];
  return readdirSync(full).flatMap((entry) => files(join(path, entry)));
}

const hasWords = (text: string) => /[A-Za-z]{2,}/.test(text);

/** Prose: more than one word, or one capitalised word, as opposed to an identifier or a token. */
function looksLikeText(text: string): boolean {
  if (!hasWords(text)) return false;
  if (/\s/.test(text.trim())) return true;
  return /^[A-Z][a-z]{2,}/.test(text);
}

function found(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(join(ROOT, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const problems: string[] = [];
  const report = (node: ts.Node, text: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    const shown = text.replace(/\s+/g, " ").trim();
    if (!ALLOWED.has(`${path}: ${shown}`)) problems.push(`${path}:${String(line + 1)}  ${shown}`);
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

  /** Whether a literal can reach the user: not an import path, key, comparison or error text. */
  function isProse(node: ts.Node): boolean {
    const parent = node.parent;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return false;
    if (ts.isJsxAttribute(parent)) return false; // text-like attributes are checked above
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
      const callee = parent.expression.getText(source);
      // Developer-facing text: errors, logs, DOM lookups and storage keys.
      if (
        /^(new )?(Error|SourceError|SetupError)$|console\.|querySelector|getItem|setItem|getElementById|addEventListener|removeEventListener|matchMedia|createElement|Reflect|Object\.|JSON\.|String|Number/.test(
          callee,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  visit(source);
  return problems;
}

describe("user-visible text lives in the catalog", () => {
  it("has no hard-coded UI strings in the UI layer", () => {
    const all = SCANNED.flatMap(files)
      .filter((path) => /\.tsx?$/.test(path))
      .flatMap(found);
    expect(all, `Move these into src/i18n (see docs/i18n.md):\n${all.join("\n")}`).toEqual([]);
  });
});

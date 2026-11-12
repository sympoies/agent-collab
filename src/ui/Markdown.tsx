// A deliberately small Markdown subset rendered as React elements. Text is never turned into
// HTML: raw HTML stays text, images are not loaded, and only http(s) links are links.

import type { ReactNode } from "react";

import { useT, type Translate } from "../i18n/LocaleProvider";
import { classifyRef } from "../message/refs";
import { describeUrl } from "../message/urlLabel";

// A link target may contain one level of balanced parentheses (`[a](https://x.example/a_(b))`),
// so a target such as `javascript:alert(1)` is consumed whole instead of leaving a stray `)`.
// Every quantifier is bounded so a hostile file cannot make the scan quadratic, and a line longer
// than MAX_INLINE_LENGTH is shown as plain text without any scan at all.
const INLINE_RE =
  /(`[^`]{1,500}`|\*\*[^*]{1,500}\*\*|\*[^*\s][^*]{0,500}\*|!?\[[^\]]{0,500}\]\((?:[^()\s]|\([^()\s]{0,500}\)){0,2000}\))/;
const MAX_INLINE_LENGTH = 2000;

const LINK_RE = /^(!?)\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)$/;

/**
 * The text of one line without its inline markers: a link shows its text (or a readable URL label when it
 * has none), an image its alt text, emphasis and code only their content. For places that sit inside a
 * link or a clamped block, where rendering the inline elements is not safe. Unbalanced markers and
 * lines longer than the scan limit stay as written.
 */
export function plainInline(text: string, t: Translate): string {
  if (text.length > MAX_INLINE_LENGTH) return text;
  return text
    .split(INLINE_RE)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return part.slice(1, -1);
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return part.slice(2, -2);
      if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return part.slice(1, -1);
      const link = LINK_RE.exec(part);
      if (link === null) return part;
      const [, , label = "", target = ""] = link;
      if (label !== "") return label;
      const ref = classifyRef(target);
      return ref.kind === "url" ? describeUrl(ref.href, t).label : target;
    })
    .join("");
}

/** The first visible line after Markdown block syntax, with code kept literal. */
export function firstBlockLine(lines: readonly string[]): {
  readonly text: string;
  readonly code: boolean;
} {
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) return { text: "", code: false };
  const line = lines[first] ?? "";
  if (line.startsWith("```")) {
    for (const codeLine of lines.slice(first + 1)) {
      if (codeLine.startsWith("```")) return { text: "", code: true };
      if (codeLine.trim() !== "") return { text: codeLine, code: true };
    }
    return { text: "", code: true };
  }
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading !== null) return { text: heading[2] ?? "", code: false };
  const quote = /^>\s?(.*)$/.exec(line);
  if (quote !== null) return { text: quote[1] ?? "", code: false };
  const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
  if (bullet !== null) return { text: bullet[1] ?? "", code: false };
  const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (numbered !== null) return { text: numbered[1] ?? "", code: false };
  return { text: line, code: false };
}

function inline(text: string, keyPrefix: string, t: Translate): ReactNode[] {
  if (text.length > MAX_INLINE_LENGTH) return [text];
  return text.split(INLINE_RE).flatMap((part, index): ReactNode[] => {
    const key = `${keyPrefix}-${String(index)}`;
    if (part === "") return [];
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return [<code key={key}>{part.slice(1, -1)}</code>];
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return [<strong key={key}>{part.slice(2, -2)}</strong>];
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return [<em key={key}>{part.slice(1, -1)}</em>];
    }
    const link = LINK_RE.exec(part);
    if (link !== null) {
      const [, image, label = "", target = ""] = link;
      // An image is never fetched; its alt text is shown instead.
      if (image === "!") return [label === "" ? target : label];
      const ref = classifyRef(target);
      if (ref.kind === "url") {
        const described = label === "" ? describeUrl(ref.href, t) : null;
        return [
          <a
            key={key}
            href={ref.href}
            target="_blank"
            rel="noopener noreferrer"
            title={described?.title}
          >
            {described?.label ?? label}
          </a>,
        ];
      }
      return [label === "" ? target : label];
    }
    return [part];
  });
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "paragraph"; text: string };

function blocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const result: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) result.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      result.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (line.trim() === "") flush();
    else if (heading !== null) {
      flush();
      result.push({ kind: "heading", level: (heading[1] ?? "#").length, text: heading[2] ?? "" });
    } else if (bullet !== null || numbered !== null) {
      flush();
      const ordered = numbered !== null;
      const item = (ordered ? numbered[1] : bullet?.[1]) ?? "";
      const last = result[result.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item);
      else result.push({ kind: "list", ordered, items: [item] });
    } else if (quote !== null) {
      flush();
      result.push({ kind: "quote", text: quote[1] ?? "" });
    } else paragraph.push(line.trim());
  }
  flush();
  return result;
}

export function Markdown({ text }: { readonly text: string }) {
  const t = useT();
  return (
    <div className="markdown">
      {blocks(text).map((block, index) => {
        const key = String(index);
        switch (block.kind) {
          case "heading": {
            const Tag = `h${String(block.level)}` as "h1";
            return <Tag key={key}>{inline(block.text, key, t)}</Tag>;
          }
          case "code":
            return (
              <pre key={key}>
                <code>{block.text}</code>
              </pre>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item, `${key}-${String(itemIndex)}`, t)}</li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return <blockquote key={key}>{inline(block.text, key, t)}</blockquote>;
          case "paragraph":
            return <p key={key}>{inline(block.text, key, t)}</p>;
        }
      })}
    </div>
  );
}

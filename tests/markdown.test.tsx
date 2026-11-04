import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "../src/ui/Markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("renders headings, paragraphs, lists, quotes, code blocks and inline styles", () => {
    const out = html(
      [
        "# Title",
        "",
        "Some **bold**, *italic* and `code`.",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "```",
        "a < b",
        "```",
      ].join("\n"),
    );
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(out).toContain("<blockquote>quoted</blockquote>");
    expect(out).toContain("<pre><code>a &lt; b</code></pre>");
  });

  it("shows raw HTML as text and never creates elements from it", () => {
    const out = html(
      '<script>alert(1)</script> <img src="https://evil.example/x.png" onerror="x">',
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  it("links only http and https URLs, in a new tab without opener", () => {
    const out = html("[docs](https://docs.example.com/a) and [bad](javascript:alert(1))");
    expect(out).toContain(
      '<a href="https://docs.example.com/a" target="_blank" rel="noopener noreferrer">docs</a>',
    );
    expect(out).not.toContain('javascript:alert(1)"');
    expect(out).not.toContain('href="javascript');
    expect(out).toContain("bad");
  });

  it("drops no characters around an unsafe link whose target has parentheses", () => {
    expect(html("see [bad](javascript:alert(1)) now")).toContain("<p>see bad now</p>");
    expect(html("![chart](x.png(1)) end")).toContain("<p>chart end</p>");
  });

  it("keeps a balanced parenthesis inside a link target", () => {
    const out = html("[wiki](https://docs.example.com/a_(b)) and more");
    expect(out).toContain('href="https://docs.example.com/a_(b)"');
    expect(out).toContain("</a> and more");
  });

  it("does not load images: image syntax becomes text", () => {
    const out = html("![chart](https://evil.example/x.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("chart");
  });

  it("keeps unterminated markers, a lone backtick and an unclosed fence as text", () => {
    expect(html("**not closed")).toContain("**not closed");
    expect(html("a lone ` backtick")).toContain("a lone ` backtick");
    const fenced = html("```\ncode without end\nmore");
    expect(fenced).toContain("<pre><code>code without end\nmore</code></pre>");
  });

  it("shows a very long line as one plain paragraph", () => {
    const line = `**bold** ${"x".repeat(10_000)}`;
    const out = html(line);
    expect(out).not.toContain("<strong>");
    expect(out).toContain("x".repeat(10_000));
  });

  it("never mentions the target of an image or an unsafe link", () => {
    const out = html("![chart](https://evil.example/x.png) [bad](javascript:alert(1))");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("<a ");
    expect(out).toContain("chart");
    expect(out).toContain("bad");
  });

  it.each([
    ["open brackets", "[".repeat(200_000)],
    ["unclosed links", "[a](".repeat(50_000)],
    ["unclosed bold", "**".repeat(100_000)],
    ["backticks", "`".repeat(200_000)],
    ["stars", "*a ".repeat(60_000)],
    ["many short lines", "[a](\n".repeat(40_000)],
  ])("renders %s in bounded time", (_name, text) => {
    const started = performance.now();
    html(text);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

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

  it("does not load images: image syntax becomes text", () => {
    const out = html("![chart](https://evil.example/x.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("chart");
  });
});

import { describe, expect, it } from "vitest";

import { classifyRef, fileKindOf, imageMime } from "../src/message/refs";

describe("classifyRef", () => {
  it("recognises a message id", () => {
    expect(classifyRef("2026-10-08T0905-alice-agent-api-01")).toEqual({
      kind: "message",
      id: "2026-10-08T0905-alice-agent-api-01",
    });
  });

  it("recognises a file under topics/ with its name, directory and kind", () => {
    expect(classifyRef("topics/api/fields-v1.md")).toEqual({
      kind: "file",
      path: "topics/api/fields-v1.md",
      name: "fields-v1.md",
      directory: "topics/api",
      fileKind: "markdown",
    });
  });

  it.each([
    "topics/../secret.md",
    "topics/./a.md",
    "topics//a.md",
    "topics/a\\b.md",
    "topics/%2e%2e/a.md",
    "/topics/a.md",
    "inbox/2026-10/a.md",
    "topics/",
    "topics",
    "topics/a\u0000.md",
  ])("keeps an unsafe or foreign path as plain text: %s", (ref) => {
    expect(classifyRef(ref)).toEqual({ kind: "text", text: ref });
  });

  it("accepts only http and https URLs without credentials and shows the host", () => {
    expect(classifyRef("https://docs.example.com/a/b?x=1")).toEqual({
      kind: "url",
      href: "https://docs.example.com/a/b?x=1",
    });
    expect(classifyRef("http://example.com").kind).toBe("url");
    for (const ref of [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "ftp://example.com/a",
      "https://user:pass@example.com/",
      "not a url",
    ]) {
      expect(classifyRef(ref)).toEqual({ kind: "text", text: ref });
    }
  });
});

describe("fileKindOf", () => {
  it.each([
    ["notes.md", "markdown"],
    ["README.MARKDOWN", "markdown"],
    ["log.txt", "text"],
    ["config.json", "text"],
    ["data.csv", "csv"],
    ["data.tsv", "csv"],
    ["shot.PNG", "image"],
    ["photo.jpeg", "image"],
    ["icon.svg", "other"],
    ["archive.zip", "other"],
    ["Makefile", "other"],
  ])("%s is %s", (name, kind) => {
    expect(fileKindOf(name)).toBe(kind);
  });

  it("gives raster images a MIME type and nothing else", () => {
    expect(imageMime("a.png")).toBe("image/png");
    expect(imageMime("a.jpg")).toBe("image/jpeg");
    expect(imageMime("a.svg")).toBeNull();
    expect(imageMime("a.md")).toBeNull();
  });
});

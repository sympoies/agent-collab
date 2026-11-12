import { describe, expect, it } from "vitest";

import { translate } from "../src/i18n/translate";
import { describeUrl, URL_LABEL_MAX_LENGTH } from "../src/message/urlLabel";

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);
const label = (href: string) => describeUrl(href, en).label;

describe("describeUrl", () => {
  it.each([
    ["https://jira.example.test/browse/PROJ-123", "PROJ-123"],
    ["https://jira.example.test/browse/PROJ-123?focusedCommentId=456", "PROJ-123 · comment 456"],
    ["https://jira.example.test/browse/PROJ-123?focusedCommentId=x", "PROJ-123"],
    ["https://gitlab.example.test/group/sub/app/-/merge_requests/12", "app!12"],
    ["https://gitlab.example.test/group/app/-/issues/7", "app#7"],
    ["https://gitlab.example.test/group/app/-/work_items/8", "app#8"],
    ["https://github.example.test/owner/repo/pull/12", "repo#12"],
    ["https://github.example.test/owner/repo/pull/12/files", "repo#12"],
    ["https://github.example.test/owner/repo/issues/5", "repo#5"],
    [
      "https://github.example.test/owner/repo/commit/0123456789abcdef0123456789abcdef01234567",
      "repo@0123456",
    ],
    [
      "https://gitlab.example.test/group/app/-/commit/89abcdef0123456789abcdef0123456789abcdef",
      "app@89abcde",
    ],
    ["https://github.example.test/owner/repo/blob/main/docs/guide.md", "guide.md"],
    ["https://gitlab.example.test/group/app/-/blob/main/src/a%20b.ts", "a b.ts"],
    ["https://docs.example.test/guide/setup", "docs.example.test · …/setup"],
    ["https://docs.example.test/guide/setup/?x=1#top", "docs.example.test · …/setup"],
    ["https://docs.example.test/", "docs.example.test"],
    ["https://docs.example.test", "docs.example.test"],
  ])("labels %s as %s", (url, expected) => {
    expect(label(url)).toBe(expected);
  });

  it("keeps the full URL as the title", () => {
    const url = "https://jira.example.test/browse/PROJ-123?focusedCommentId=456";
    expect(describeUrl(url, en).title).toBe(url);
  });

  it("translates the comment word", () => {
    const url = "https://jira.example.test/browse/PROJ-123?focusedCommentId=456";
    expect(describeUrl(url, (key, params) => translate("ja", key, params)).label).toBe(
      "PROJ-123 · コメント 456",
    );
    expect(describeUrl(url, (key, params) => translate("zh-TW", key, params)).label).toBe(
      "PROJ-123 · 留言 456",
    );
  });

  it("bounds very long segments and keeps the host for unknown shapes", () => {
    const long = `https://docs.example.test/${"a".repeat(500)}`;
    const out = label(long);
    expect(out.startsWith("docs.example.test · …/")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(URL_LABEL_MAX_LENGTH);
    expect(
      label(`https://gitlab.example.test/g/${"p".repeat(500)}/-/merge_requests/1`).length,
    ).toBeLessThanOrEqual(URL_LABEL_MAX_LENGTH);
  });

  it.each([
    ["https://github.example.test/owner/repo/blob/main/%00", "github.example.test"],
    ["https://github.example.test/owner/repo/blob/main/%E2%80%AE", "github.example.test"],
    ["https://github.example.test/owner/repo/blob/main/%20", "github.example.test"],
    ["https://github.example.test/owner/repo/blob/main/%20x", "x"],
  ])("never returns an empty label: %s", (url, expected) => {
    const out = label(url);
    expect(out.trim()).not.toBe("");
    expect(out).toContain(expected);
  });

  it("treats malformed and hostile input as plain bounded text", () => {
    expect(label("not a url")).toBe("not a url");
    expect(label("https://docs.example.test/%E0%A4%A")).toBe("docs.example.test · …/%E0%A4%A");
    expect(label("https://docs.example.test/<img src=x onerror=1>")).toContain("<img");
    expect(label("x".repeat(500)).length).toBeLessThanOrEqual(URL_LABEL_MAX_LENGTH);
    expect(label("https://docs.example.test/a\u0000b‮c")).not.toMatch(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f‮]/,
    );
  });
});

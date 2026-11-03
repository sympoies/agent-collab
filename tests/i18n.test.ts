import { describe, expect, it } from "vitest";

import { ja } from "../src/i18n/ja";
import { en, LOCALES, type Locale } from "../src/i18n/catalog";
import { detectLocale, formatDateTime, translate } from "../src/i18n/translate";
import { zhTW } from "../src/i18n/zh-TW";

const catalogs: Record<Locale, Record<string, string>> = { en, ja, "zh-TW": zhTW };

/** Names used by a message: {name} placeholders and the argument of a plural form. */
function placeholders(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\{(\w+)(?:,\s*plural,)?/g)) names.add(match[1] ?? "");
  return [...names].sort();
}

describe("message catalogs", () => {
  it("has the same keys in every locale, with no extra or missing key", () => {
    const keys = Object.keys(en).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(catalogs[locale]).sort(), locale).toEqual(keys);
    }
  });

  it("uses the same placeholders in every translation as in English", () => {
    for (const [key, text] of Object.entries(en)) {
      for (const locale of LOCALES) {
        expect(placeholders(catalogs[locale][key] ?? ""), `${locale}: ${key}`).toEqual(
          placeholders(text),
        );
      }
    }
  });

  it("has no empty translation, and a plural form always has an other case", () => {
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(catalogs[locale])) {
        expect(text.trim(), `${locale}: ${key}`).not.toBe("");
        if (text.includes(", plural,")) expect(text, `${locale}: ${key}`).toContain("other {");
      }
    }
  });
});

describe("translate", () => {
  const demo = {
    en: {
      greeting: "Hello, {name}!",
      comments: "{count, plural, one {# comment} other {# comments}}",
      only: "Only English",
    },
    ja: { greeting: "こんにちは、{name}さん", comments: "{count, plural, other {コメント # 件}}" },
    "zh-TW": {},
  };
  const t = (locale: Locale, key: string, params: Record<string, string | number> = {}) =>
    translate(locale, key as never, params, demo);

  it("interpolates named parameters and leaves unknown ones visible", () => {
    expect(t("en", "greeting", { name: "Alice" })).toBe("Hello, Alice!");
    expect(t("en", "greeting")).toBe("Hello, {name}!");
    expect(t("ja", "greeting", { name: "Alice" })).toBe("こんにちは、Aliceさん");
  });

  it("selects a plural form by the locale's rules and puts the count in with #", () => {
    expect(t("en", "comments", { count: 1 })).toBe("1 comment");
    expect(t("en", "comments", { count: 2 })).toBe("2 comments");
    expect(t("en", "comments", { count: 0 })).toBe("0 comments");
    // Japanese has a single form.
    expect(t("ja", "comments", { count: 1 })).toBe("コメント 1 件");
    expect(t("ja", "comments", { count: 5 })).toBe("コメント 5 件");
  });

  it("formats the count in the locale's grouping", () => {
    expect(t("en", "comments", { count: 1200 })).toBe("1,200 comments");
  });

  it("falls back to English for a missing translation, and to the key for an unknown key", () => {
    expect(t("zh-TW", "only")).toBe("Only English");
    expect(t("en", "no.such.key")).toBe("no.such.key");
  });
});

describe("plural edge cases and real messages", () => {
  const plural = {
    en: { n: "{count, plural, one {# item} other {# items}}" },
    ja: {},
    "zh-TW": { n: "{count, plural, other {# 項}}" },
  };
  const run = (locale: Locale, params: Record<string, string | number>) =>
    translate(locale, "n" as never, params, plural);

  it("keeps the visible template when the count is missing or not a number", () => {
    expect(run("en", {})).toBe("{count, plural, one {# item} other {# items}}");
    expect(run("en", { count: "3" })).toBe("{count, plural, one {# item} other {# items}}");
  });

  it("uses the single form of Traditional Chinese", () => {
    expect(run("zh-TW", { count: 1 })).toBe("1 項");
    expect(run("zh-TW", { count: 7 })).toBe("7 項");
  });

  it("renders the real counted messages in every locale", () => {
    const expected = {
      en: ["3 open", "2 new"],
      ja: ["未回答 3 件", "新着 2 件"],
      "zh-TW": ["3 則未回覆", "2 則新訊息"],
    } as const;
    for (const locale of LOCALES) {
      expect(translate(locale, "nav.questionsOpen", { count: 3 }), locale).toBe(
        expected[locale][0],
      );
      expect(translate(locale, "nav.fresh", { count: 2 }), locale).toBe(expected[locale][1]);
    }
  });

  it("uses # in every plural form of every catalog", () => {
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(catalogs[locale])) {
        for (const form of text.matchAll(/(\w+)\s*\{([^}]*)\}/g)) {
          if (text.includes(", plural,") && /^(zero|one|two|few|many|other)$/.test(form[1] ?? "")) {
            expect(form[2], `${locale}: ${key} (${form[1] ?? ""})`).toContain("#");
          }
        }
      }
    }
  });
});

describe("detectLocale", () => {
  it.each([
    [["ja"], "ja"],
    [["ja-JP", "en"], "ja"],
    [["zh-TW"], "zh-TW"],
    [["zh-Hant-HK"], "zh-TW"],
    [["zh-HK"], "zh-TW"],
    [["zh-MO"], "zh-TW"],
    [["zh-Hant"], "zh-TW"],
    [["ZH-tw"], "zh-TW"],
    [["JA-jp"], "ja"],
    [["fr", "ja"], "ja"],
    [["fr", "de"], "en"],
    [["zh-CN"], "en"],
    [["zh"], "en"],
    [["zh-Hans"], "en"],
    [["zh-CN", "ja"], "ja"],
    [["en-GB", "ja"], "en"],
    [["en-US"], "en"],
    [[""], "en"],
    [["", "ja"], "ja"],
    [["not a language", "zh-TW"], "zh-TW"],
    [["zh-twx"], "en"],
    [["zh-hantx"], "en"],
    [["jaa"], "en"],
    [["j"], "en"],
    [[], "en"],
  ])("picks the first supported language of %j: %s", (languages, expected) => {
    expect(detectLocale(languages)).toBe(expected);
  });
});

describe("date formatting", () => {
  it.each([
    ["en", /^Nov 3, 2026, 8:05\sAM$/],
    ["ja", /^2026\/11\/03 8:05$/],
    ["zh-TW", /^2026年11月3日 上午8:05$/],
  ] as const)("formats a fixed time in UTC for %s", (locale, expected) => {
    expect(formatDateTime(locale, new Date("2026-11-03T08:05:00Z"), "UTC")).toMatch(expected);
  });
});

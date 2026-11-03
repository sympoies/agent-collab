// Dependency-free translation helper: named {placeholders} and one plural form per message.

import { en, LOCALES, type Locale, type MessageKey } from "./catalog";
import { ja } from "./ja";
import { zhTW } from "./zh-TW";

export type Params = Readonly<Record<string, string | number>>;
type Source = Readonly<Record<Locale, Readonly<Partial<Record<string, string>>>>>;

const CATALOGS: Source = { en, ja, "zh-TW": zhTW };

const PLURAL = /\{(\w+),\s*plural,((?:\s*\w+\s*\{[^}]*\})+)\s*\}/g;
const FORM = /(\w+)\s*\{([^}]*)\}/g;

function plural(locale: Locale, text: string, params: Params): string {
  return text.replace(PLURAL, (whole, name: string, forms: string) => {
    const value = params[name];
    if (typeof value !== "number") return whole;
    const chosen = new Intl.PluralRules(locale).select(value);
    const table = new Map<string, string>();
    for (const form of forms.matchAll(FORM)) table.set(form[1] ?? "", form[2] ?? "");
    const template = table.get(chosen) ?? table.get("other") ?? "";
    return template.replaceAll("#", new Intl.NumberFormat(locale).format(value));
  });
}

/**
 * The message for `key` in `locale`: the English text when the locale lacks it, and the key itself
 * when English lacks it too. Unknown placeholders stay visible so a gap is easy to spot.
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  params: Params = {},
  source: Source = CATALOGS,
): string {
  const text = source[locale][key] ?? source.en[key] ?? key;
  return plural(locale, text, params).replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** The first browser language the viewer supports, or English. */
export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (tag === "en" || tag.startsWith("en-")) return "en";
    if (tag === "ja" || tag.startsWith("ja-")) return "ja";
    // Traditional Chinese: Taiwan, Hong Kong, Macau and the Hant script.
    if (/^zh-(tw|hk|mo|hant)/.test(tag)) return "zh-TW";
  }
  return "en";
}

export { LOCALES };

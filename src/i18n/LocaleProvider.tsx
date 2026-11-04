// Locale selection: the saved choice, else the browser's language, else English. The choice is a
// per-viewer preference kept in guarded storage; the page works without storage.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { GlobeIcon } from "../ui/icons";
import { LOCALE_NAMES, LOCALES, type Locale, type MessageKey } from "./catalog";
import { detectLocale, formatDateTime, translate, type Params } from "./translate";

type LocaleStorage = Pick<Storage, "getItem" | "setItem">;

export const LOCALE_KEY = "agent-collab-viewer.locale";

export type Translate = (key: MessageKey, params?: Params) => string;

interface LocaleContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: Translate;
  /** A date and time in the chosen locale, from `Intl`. */
  readonly formatDateTime: (date: Date) => string;
}

function value(locale: Locale, setLocale: (locale: Locale) => void): LocaleContextValue {
  return {
    locale,
    setLocale,
    t: (key, params) => translate(locale, key, params),
    formatDateTime: (date) => formatDateTime(locale, date),
  };
}

/** Without a provider (a bare component in a test) the viewer is English and cannot switch. */
const LocaleContext = createContext<LocaleContextValue>(value("en", () => undefined));

function savedLocale(storage: LocaleStorage): Locale | null {
  try {
    const saved = storage.getItem(LOCALE_KEY);
    return LOCALES.find((locale) => locale === saved) ?? null;
  } catch {
    // Storage can be unavailable; the browser language decides.
    return null;
  }
}

function browserLocale(): Locale {
  return detectLocale(
    window.navigator.languages.length > 0
      ? window.navigator.languages
      : [window.navigator.language],
  );
}

export function LocaleProvider({
  storage,
  children,
}: {
  readonly storage: LocaleStorage;
  readonly children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => savedLocale(storage) ?? browserLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const context = useMemo(
    () =>
      value(locale, (next) => {
        setLocaleState(next);
        try {
          storage.setItem(LOCALE_KEY, next);
        } catch {
          // Keep the choice for this page even when it cannot be saved.
        }
      }),
    [locale, storage],
  );
  return <LocaleContext.Provider value={context}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

export function useT(): Translate {
  return useContext(LocaleContext).t;
}

/** A visible language switcher; each language is named in itself. */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useLocale();
  return (
    <label className="language-switcher" title={t("language.label")}>
      <GlobeIcon />
      <span className="sr-only">{t("language.label")}</span>
      <select
        aria-label={t("language.label")}
        value={locale}
        onChange={(event) => {
          const next = LOCALES.find((candidate) => candidate === event.target.value);
          if (next !== undefined) setLocale(next);
        }}
      >
        {LOCALES.map((candidate) => (
          <option key={candidate} value={candidate} lang={candidate}>
            {LOCALE_NAMES[candidate]}
          </option>
        ))}
      </select>
    </label>
  );
}

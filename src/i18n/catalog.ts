// The message catalog. English is the source of truth and the fallback: every other locale must
// have exactly the same keys (the type checks it, and tests/i18n.test.ts checks placeholders).
// Messages may contain {name} placeholders and one plural form per message:
// {count, plural, one {# item} other {# items}}, where # is the count.

export const LOCALES = ["en", "ja", "zh-TW"] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language in its own language, so a reader can find theirs. These are never translated. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: "English",
  ja: "日本語",
  "zh-TW": "繁體中文",
};

export const en = {
  "app.title": "Agent collaboration viewer",
  "app.settingsTitle": "Collab Viewer",
  "language.label": "Language",
  "theme.use": "Use {theme} theme",
  "theme.nightOwl": "Night Owl",
  "theme.paper": "Paper",
  "welcome.openLiveDemo": "Open live demo",
  "welcome.openSaved": "Open saved repository",
  "welcome.openAnother": "Open another repository",
  "welcome.openLocal": "Open local folder (experimental)",
  "welcome.localUnsupported":
    "Opening a local folder needs a browser that can open folders, such as Chrome or Edge on a computer.",
  "bar.refresh": "Refresh",
  "bar.viewingAs": "Viewing as",
  "bar.observer": "Observer",
  "bar.profile": "Profile & colors",
  "bar.localFolder": "Local folder",
  "bar.settings": "Settings",
  "bar.checkLive": "Check live now",
  "nav.conversations": "Conversations",
  "nav.topics": "Topics",
  "nav.questions": "Questions",
  "nav.questionsOpen": "{count} open",
  "nav.files": "Files",
  "nav.all": "All",
  "nav.fresh": "{count} new",
  "nav.back": "Back to conversations",
  "nav.jumpLatest": "Jump to latest",
  "nav.loadOlder": "Load older messages",
  "heading.all": "All conversations",
  "heading.questions": "Questions",
  "heading.files": "Files",
  "heading.filesIn": "Files in #{topic}",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;

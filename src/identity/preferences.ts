// Per-viewer, per-repository identity preferences (docs/design.md, section 5): who the viewer
// is ("Viewing as"), person colors and local display names. Everything is optional local
// state: storage may be missing or throw, and nothing is ever written to the repository.

/** Palette slots a person color can use; each slot has a value per theme (styles.css). */
export const PALETTE_SIZE = 8;

const KEY_PREFIX = "agent-collab-viewer.identity:";
const MAX_ENTRIES = 200;
const MAX_NAME_LENGTH = 40;
const PERSON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The stored value of "Observer", which no participant name can equal. */
const OBSERVER = "";

export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export interface IdentityPreferences {
  /** A participant, "" for Observer, or undefined when the viewer never chose. */
  readonly viewingAs: string | undefined;
  /** Palette slot overrides by person. */
  readonly colors: Readonly<Record<string, number>>;
  /** Local display names by person. */
  readonly names: Readonly<Record<string, string>>;
}

export const EMPTY_PREFERENCES: IdentityPreferences = {
  viewingAs: undefined,
  colors: {},
  names: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanDisplayName(value: string): string {
  const printable = Array.from(value).filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  return printable.join("").trim().slice(0, MAX_NAME_LENGTH);
}

/** Keeps only well-formed entries, so a damaged or foreign value never breaks the view. */
function sanitize(value: unknown): IdentityPreferences {
  if (!isRecord(value)) return EMPTY_PREFERENCES;
  const viewingAs =
    typeof value.viewingAs === "string" &&
    (value.viewingAs === OBSERVER || PERSON_RE.test(value.viewingAs))
      ? value.viewingAs
      : undefined;
  const colors: Record<string, number> = {};
  if (isRecord(value.colors)) {
    for (const [person, slot] of Object.entries(value.colors).slice(0, MAX_ENTRIES)) {
      if (PERSON_RE.test(person) && Number.isInteger(slot) && isSlot(slot as number)) {
        colors[person] = slot as number;
      }
    }
  }
  const names: Record<string, string> = {};
  if (isRecord(value.names)) {
    for (const [person, name] of Object.entries(value.names).slice(0, MAX_ENTRIES)) {
      const cleaned = typeof name === "string" ? cleanDisplayName(name) : "";
      if (PERSON_RE.test(person) && cleaned !== "") names[person] = cleaned;
    }
  }
  return { viewingAs, colors, names };
}

function isSlot(slot: number): boolean {
  return slot >= 0 && slot < PALETTE_SIZE;
}

export function readPreferences(
  storage: PreferenceStorage | null,
  repositoryKey: string,
): IdentityPreferences {
  if (storage === null) return EMPTY_PREFERENCES;
  try {
    const text = storage.getItem(`${KEY_PREFIX}${repositoryKey}`);
    return text === null ? EMPTY_PREFERENCES : sanitize(JSON.parse(text));
  } catch {
    return EMPTY_PREFERENCES;
  }
}

/** Returns whether the preferences were saved; the view works from memory either way. */
export function writePreferences(
  storage: PreferenceStorage | null,
  repositoryKey: string,
  preferences: IdentityPreferences,
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(`${KEY_PREFIX}${repositoryKey}`, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function withViewingAs(
  preferences: IdentityPreferences,
  person: string | null,
): IdentityPreferences {
  return { ...preferences, viewingAs: person ?? OBSERVER };
}

export function withColor(
  preferences: IdentityPreferences,
  person: string,
  slot: number | null,
): IdentityPreferences {
  const others = Object.entries(preferences.colors).filter(([name]) => name !== person);
  const entries = slot !== null && isSlot(slot) ? [...others, [person, slot]] : others;
  return { ...preferences, colors: Object.fromEntries(entries) as Record<string, number> };
}

export function withDisplayName(
  preferences: IdentityPreferences,
  person: string,
  name: string,
): IdentityPreferences {
  const cleaned = cleanDisplayName(name);
  const others = Object.entries(preferences.names).filter(([key]) => key !== person);
  const entries = cleaned === "" ? others : [...others, [person, cleaned]];
  return { ...preferences, names: Object.fromEntries(entries) as Record<string, string> };
}

/** Restores default colors and display names; "Viewing as" is a different choice and stays. */
export function resetProfile(preferences: IdentityPreferences): IdentityPreferences {
  return { ...preferences, colors: {}, names: {} };
}

/**
 * The person the viewer is, or null for Observer. A saved participant who is not in the roster
 * (left, renamed, or the roster could not be read) is ignored without being forgotten; the
 * default is the first of the configured own names that is a participant.
 */
export function resolveViewer(
  preferences: IdentityPreferences,
  participants: readonly string[],
  ownNames: readonly string[],
): string | null {
  const saved = preferences.viewingAs;
  if (saved === OBSERVER) return null;
  if (saved !== undefined && participants.includes(saved)) return saved;
  return ownNames.find((name) => participants.includes(name)) ?? null;
}

/**
 * Everyone who needs a color, in default-assignment order: the roster order first, then former
 * participants, then any other sender in name order, so a default never depends on load order.
 */
export function colorOrder(
  participants: readonly string[],
  formerParticipants: readonly string[],
  senders: Iterable<string>,
): readonly string[] {
  const known = new Set([...participants, ...formerParticipants]);
  const others = [...new Set(senders)].filter((name) => !known.has(name)).sort();
  return [...new Set([...participants, ...formerParticipants]), ...others];
}

/** Palette slot of every person: the saved override, else the order index wrapped around. */
export function assignSlots(
  order: readonly string[],
  preferences: IdentityPreferences,
): ReadonlyMap<string, number> {
  return new Map(
    order.map((person, index) => [person, preferences.colors[person] ?? index % PALETTE_SIZE]),
  );
}

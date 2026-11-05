// How people are shown in the timeline: palette slot (color) and display name.

import { assignSlots, type IdentityPreferences } from "../identity/preferences";

export interface People {
  /** Palette slot of a person; the same slot always has a readable color in both themes. */
  slot(name: string): number;
  /** The local display name, or the participant name when none was set. */
  label(name: string): string;
  /** The letters of the avatar: from the display name when one was set, else from the name. */
  initials(name: string): string;
  /** Whether the person is on the roster or has sent a message (an unknown recipient is not). */
  has(name: string): boolean;
  /** The person the viewer is, or null for Observer. */
  readonly viewer: string | null;
}

/** The first letters of up to two words of a display name; one word gives its first character. */
function displayInitials(display: string): string {
  const words = display.split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? words.slice(0, 2).map((word) => Array.from(word)[0] ?? "")
      : [Array.from(words[0] ?? "")[0] ?? ""];
  return letters.join("").toUpperCase();
}

/** The first letters of up to two parts of a participant name such as "alice-agent". */
function nameInitials(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function buildPeople(
  order: readonly string[],
  preferences: IdentityPreferences,
  viewer: string | null = null,
): People {
  const slots = assignSlots(order, preferences);
  // A display name that equals another person's shown name or id would make two people look
  // alike, so it gets the participant name appended. A person without a display name always
  // shows the participant name.
  const shown = new Map(order.map((name) => [name, preferences.names[name] ?? name]));
  const labels = new Map(
    order.map((name) => {
      const display = preferences.names[name];
      if (display === undefined) return [name, name];
      const clash = order.some((other) => other !== name && shown.get(other) === display);
      return [name, clash ? `${display} (${name})` : display];
    }),
  );
  return {
    slot: (name) => slots.get(name) ?? 0,
    label: (name) => labels.get(name) ?? preferences.names[name] ?? name,
    initials: (name) => {
      const display = preferences.names[name];
      return display === undefined ? nameInitials(name) : displayInitials(display);
    },
    has: (name) => slots.has(name),
    viewer,
  };
}

/**
 * The person's color as a data attribute. The stylesheet maps `data-slot` to the theme-aware
 * `--person` property, so components never hard-code colors or emit inline styles.
 */
export function personSlot(slot: number): { "data-slot": number } {
  return { "data-slot": slot };
}

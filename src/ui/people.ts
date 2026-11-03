// How people are shown in the timeline: palette slot (color) and display name.

import type { CSSProperties } from "react";

import { assignSlots, type IdentityPreferences } from "../identity/preferences";

export interface People {
  /** Palette slot of a person; the same slot always has a readable color in both themes. */
  slot(name: string): number;
  /** The local display name, or the participant name when none was set. */
  label(name: string): string;
}

export function buildPeople(order: readonly string[], preferences: IdentityPreferences): People {
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
  };
}

/** The person's color as a theme-aware custom property; components never hard-code colors. */
export function personStyle(slot: number): CSSProperties {
  return { "--person": `var(--person-${String(slot)})` } as CSSProperties;
}

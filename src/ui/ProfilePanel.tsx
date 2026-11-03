// "Profile & colors": local color and display-name choices per person. Nothing here is
// written to the collaboration repository.

import { useState } from "react";

import { useT } from "../i18n/LocaleProvider";
import { PALETTE_SIZE, type IdentityPreferences } from "../identity/preferences";
import { personStyle, type People } from "./people";

/** Catalog keys of the palette slot names, for the color choices' accessible labels. */
export const SLOT_NAMES = [
  "color.coral",
  "color.green",
  "color.purple",
  "color.blue",
  "color.teal",
  "color.red",
  "color.amber",
  "color.slate",
] as const;

function initials(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export interface ProfilePanelProps {
  /** Everyone who has a color, in default-assignment order. */
  readonly order: readonly string[];
  readonly preferences: IdentityPreferences;
  readonly people: People;
  readonly onColor: (person: string, slot: number | null) => void;
  readonly onDisplayName: (person: string, name: string) => void;
  readonly onReset: () => void;
}

export function ProfilePanel({
  order,
  preferences,
  people,
  onColor,
  onDisplayName,
  onReset,
}: ProfilePanelProps) {
  const t = useT();
  // Display-name inputs keep their own text while typing; a reset starts them over.
  const [resets, setResets] = useState(0);
  return (
    <section className="profile" aria-labelledby="profile-heading">
      <div className="profile-head">
        <h2 id="profile-heading">{t("profile.title")}</h2>
        <button
          type="button"
          onClick={() => {
            setResets(resets + 1);
            onReset();
          }}
        >
          {t("profile.reset")}
        </button>
      </div>
      <p className="note">{t("profile.note")}</p>
      {order.length === 0 ? (
        <p className="note">{t("profile.empty")}</p>
      ) : (
        <ul className="profile-list">
          {order.map((person) => {
            const slot = people.slot(person);
            return (
              <li key={`${person}-${String(resets)}`} className="profile-person">
                <span className="profile-who" style={personStyle(slot)}>
                  <span className="avatar" aria-hidden="true">
                    {initials(person)}
                  </span>
                  <span className="sender">{people.label(person)}</span>
                </span>
                <label className="profile-name">
                  <span>{t("profile.displayName", { name: person })}</span>
                  <input
                    type="text"
                    maxLength={40}
                    defaultValue={preferences.names[person] ?? ""}
                    placeholder={person}
                    onBlur={(event) => {
                      onDisplayName(person, event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </label>
                <fieldset className="swatches">
                  <legend>{t("profile.color", { name: person })}</legend>
                  {Array.from({ length: PALETTE_SIZE }, (_, index) => (
                    <label key={index} className="swatch" style={personStyle(index)}>
                      <input
                        type="radio"
                        aria-label={t(SLOT_NAMES[index] ?? "color.coral")}
                        name={`color-${person}`}
                        checked={slot === index}
                        onChange={() => {
                          onColor(person, index);
                        }}
                      />
                    </label>
                  ))}
                </fieldset>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

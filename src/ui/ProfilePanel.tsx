// "Profile & colors": local color and display-name choices per person. Nothing here is
// written to the collaboration repository.

import { useEffect, useRef, useState } from "react";

import { useT } from "../i18n/LocaleProvider";
import { PALETTE_SIZE, type IdentityPreferences } from "../identity/preferences";
import { personSlot, type People } from "./people";

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
  /** The person the viewer is; null for Observer. */
  readonly viewer: string | null;
  /** Who the viewer can be: the participants, or the senders seen while the roster is unknown. */
  readonly viewingAsOptions: readonly string[];
  readonly onViewingAs: (person: string | null) => void;
  readonly onColor: (person: string, slot: number | null) => void;
  readonly onDisplayName: (person: string, name: string) => void;
  readonly onReset: () => void;
  readonly onClose: () => void;
}

export function ProfilePanel({
  order,
  preferences,
  people,
  viewer,
  viewingAsOptions,
  onViewingAs,
  onColor,
  onDisplayName,
  onReset,
  onClose,
}: ProfilePanelProps) {
  const t = useT();
  // Display-name inputs keep their own text while typing; a reset starts them over.
  const [resets, setResets] = useState(0);
  const section = useRef<HTMLElement | null>(null);
  // Opening the panel moves focus into it.
  useEffect(() => {
    section.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="profile" aria-labelledby="profile-heading" tabIndex={-1} ref={section}>
      <div className="profile-head">
        <h2 id="profile-heading">{t("profile.title")}</h2>
        <div className="profile-actions">
          <button
            type="button"
            onClick={() => {
              setResets(resets + 1);
              onReset();
            }}
          >
            {t("profile.reset")}
          </button>
          <button type="button" onClick={onClose}>
            {t("profile.close")}
          </button>
        </div>
      </div>
      <label className="viewing-as">
        <span>{t("bar.viewingAs")}</span>
        <select
          value={viewer ?? ""}
          onChange={(event) => {
            onViewingAs(event.target.value === "" ? null : event.target.value);
          }}
        >
          <option value="">{t("bar.observer")}</option>
          {viewingAsOptions.map((name) => (
            <option key={name} value={name}>
              {people.label(name)}
            </option>
          ))}
        </select>
      </label>
      <p className="note">{t("profile.note")}</p>
      {order.length === 0 ? (
        <p className="note">{t("profile.empty")}</p>
      ) : (
        <ul className="profile-list">
          {order.map((person) => {
            const slot = people.slot(person);
            return (
              <li key={`${person}-${String(resets)}`} className="profile-person">
                <span className="profile-who" {...personSlot(slot)}>
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
                    <label key={index} className="swatch" {...personSlot(index)}>
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

// How far back the loaded messages go, and a way to jump to a past day without loading the days
// in between (docs/design/topics-and-scale.md, sections 6.1 and 9).

import { useState } from "react";

import { useT } from "../i18n/LocaleProvider";
import type { Message } from "../message/types";

export interface RangeBarProps {
  /** Loaded messages, oldest first. */
  readonly messages: readonly Message[];
  /** Newer messages exist and are not loaded (after a jump). */
  readonly hasNewer: boolean;
  readonly disabled: boolean;
  readonly onJump: (date: string | null) => void;
}

export function RangeBar({ messages, hasNewer, disabled, onJump }: RangeBarProps) {
  const t = useT();
  const [date, setDate] = useState("");
  const oldest = messages[0];
  const newest = messages[messages.length - 1];
  return (
    <div className="range-bar">
      {oldest !== undefined && newest !== undefined && (
        <p className="range-line">
          {hasNewer
            ? t("range.loadedPast", {
                count: messages.length,
                from: oldest.timestamp.slice(0, 10),
                to: newest.timestamp.slice(0, 10),
              })
            : t("range.loaded", {
                count: messages.length,
                date: oldest.timestamp.slice(0, 10),
              })}
        </p>
      )}
      <form
        className="range-jump"
        onSubmit={(event) => {
          event.preventDefault();
          if (date !== "") onJump(date);
        }}
      >
        <label>
          <span>{t("range.jumpLabel")}</span>
          <input
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={disabled || date === ""}>
          {t("range.jumpGo")}
        </button>
        {hasNewer && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onJump(null);
            }}
          >
            {t("range.showNewest")}
          </button>
        )}
      </form>
    </div>
  );
}

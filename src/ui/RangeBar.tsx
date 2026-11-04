// How far back the loaded messages go, and a way to jump to a past day without loading the days
// in between (docs/design/topics-and-scale.md, sections 6.1 and 9).

import { useEffect, useRef, useState } from "react";

import { useT } from "../i18n/LocaleProvider";
import type { Message } from "../message/types";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface RangeBarProps {
  /** Loaded messages, oldest first. */
  readonly messages: readonly Message[];
  /** After a jump, the last day of the loaded range; null while the newest page leads. */
  readonly jumpedTo: string | null;
  readonly disabled: boolean;
  readonly onJump: (date: string | null) => void;
}

export function RangeBar({ messages, jumpedTo, disabled, onJump }: RangeBarProps) {
  const t = useT();
  const [date, setDate] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  const awaitingJump = useRef(false);
  const oldest = messages[0];
  const newest = messages[messages.length - 1];
  // The control the reader used may disappear or be disabled while the jump runs; focus returns
  // to the date field when it is done.
  useEffect(() => {
    if (disabled || !awaitingJump.current) return;
    awaitingJump.current = false;
    input.current?.focus();
  }, [disabled]);
  const jump = (target: string | null) => {
    awaitingJump.current = true;
    onJump(target);
  };
  return (
    <div className="range-bar">
      <p className="range-line" role="status">
        {oldest === undefined || newest === undefined
          ? jumpedTo === null
            ? ""
            : t("range.noneUpTo", { date: jumpedTo })
          : jumpedTo !== null
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
      <form
        className="range-jump"
        onSubmit={(event) => {
          event.preventDefault();
          if (DAY.test(date)) jump(date);
        }}
      >
        <label>
          <span>{t("range.jumpLabel")}</span>
          <input
            ref={input}
            type="date"
            max="9999-12-31"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={disabled || !DAY.test(date)}>
          {t("range.jumpGo")}
        </button>
        {jumpedTo !== null && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              jump(null);
            }}
          >
            {t("range.showNewest")}
          </button>
        )}
      </form>
    </div>
  );
}

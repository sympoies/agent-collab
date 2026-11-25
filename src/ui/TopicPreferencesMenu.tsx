import { useRef } from "react";

import { useLocale } from "../i18n/LocaleProvider";
import type { MessageKey } from "../i18n/catalog";
import type { TopicList } from "../identity/topic-preferences";

export interface TopicPreferenceFlags {
  readonly follow: boolean;
  readonly mute: boolean;
  readonly pin: boolean;
  readonly hide: boolean;
}

export function TopicPreferencesMenu({
  topic,
  flags,
  onToggle,
}: {
  readonly topic: string;
  readonly flags: TopicPreferenceFlags;
  readonly onToggle: (list: TopicList, on: boolean) => void;
}) {
  const { t } = useLocale();
  const summaryRef = useRef<HTMLElement>(null);
  const closeAndRestoreFocus = (menu: HTMLDetailsElement) => {
    menu.open = false;
    summaryRef.current?.focus();
  };
  const options: readonly [TopicList, boolean, MessageKey, MessageKey][] = [
    ["follow", flags.follow, "topic.follow", "topic.unfollow"],
    ["mute", flags.mute, "topic.mute", "topic.unmute"],
    ["pin", flags.pin, "topic.pin", "topic.unpin"],
    ["hide", flags.hide, "topic.hide", "topic.unhide"],
  ];
  return (
    <details
      className="topic-preference-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeAndRestoreFocus(event.currentTarget);
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          event.currentTarget.open = false;
        }
      }}
    >
      <summary ref={summaryRef} aria-label={t("topic.optionsFor", { topic })}>
        •••
      </summary>
      <div
        className="topic-preference-items"
        role="group"
        aria-label={t("topic.optionsFor", { topic })}
      >
        {options.map(([list, active, onLabel, offLabel]) => (
          <button
            key={list}
            type="button"
            onClick={(event) => {
              onToggle(list, !active);
              const menu = event.currentTarget.closest("details");
              if (menu instanceof HTMLDetailsElement) closeAndRestoreFocus(menu);
            }}
          >
            {t(active ? offLabel : onLabel, { topic })}
          </button>
        ))}
      </div>
    </details>
  );
}

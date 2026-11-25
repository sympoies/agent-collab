import { useLocale } from "../i18n/LocaleProvider";
import type { TopicPreferenceFlags } from "./TopicPreferencesMenu";

/** Color-independent topic state cues: symbols for sighted readers and labels for screen readers. */
export function TopicStateCue({ flags }: { readonly flags: TopicPreferenceFlags }) {
  const { t } = useLocale();
  const active = [flags.follow, flags.mute, flags.pin].some(Boolean);
  if (!active) return null;

  return (
    <>
      <span className="topic-state-icons" aria-hidden="true">
        {flags.follow && <span>↗</span>}
        {flags.mute && <span>⊘</span>}
        {flags.pin && <span>★</span>}
      </span>
      <span className="sr-only topic-state-label">
        {[
          flags.follow && t("topic.stateFollowing"),
          flags.mute && t("topic.stateMuted"),
          flags.pin && t("topic.statePinned"),
        ]
          .filter((value): value is string => typeof value === "string")
          .join(", ")}
      </span>
    </>
  );
}

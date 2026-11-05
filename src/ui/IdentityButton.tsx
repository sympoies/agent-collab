import { useT } from "../i18n/LocaleProvider";
import { personSlot, type People } from "./people";

function initial(name: string): string {
  return name.split("-").filter(Boolean)[0]?.[0]?.toUpperCase() ?? "";
}

interface IdentityButtonProps {
  /** The person the viewer is; null for Observer. */
  readonly viewer: string | null;
  readonly people: People;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The hint is shown: the button points at it. */
  readonly hint: boolean;
}

/** The one-time hint under the header: choose who you are. */
export function IdentityHint({ onDismiss }: { readonly onDismiss: () => void }) {
  const t = useT();
  return (
    <p id="identity-hint" className="identity-hint" role="status">
      <span>{t("identity.hint")}</span>{" "}
      <button onClick={onDismiss} type="button">
        {t("identity.hintDismiss")}
      </button>
    </p>
  );
}

/** The toolbar's one identity control: who the viewer is, opening the profile panel. */
export function IdentityButton({ viewer, people, open, onToggle, hint }: IdentityButtonProps) {
  const t = useT();
  const name = viewer === null ? t("bar.observer") : people.label(viewer);
  return (
    <div className="identity">
      <button
        type="button"
        className="identity-button"
        aria-label={t("identity.button", { name })}
        aria-expanded={open}
        aria-controls="profile-panel"
        {...(hint ? { "aria-describedby": "identity-hint" } : {})}
        onClick={onToggle}
        {...(viewer === null ? {} : personSlot(people.slot(viewer)))}
      >
        <span className="avatar" aria-hidden="true">
          {viewer === null ? "?" : initial(viewer)}
        </span>
        <span className="identity-name">{name}</span>
      </button>
    </div>
  );
}

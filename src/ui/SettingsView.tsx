// Settings screen. Secret inputs are masked, never prefilled and never echoed back.

import { useLocale } from "../i18n/LocaleProvider";
import { useState, type ReactNode, type SubmitEvent } from "react";

import {
  savedForm,
  storageWarning,
  type CredentialStorage,
  type DraftErrors,
  type SettingsDraft,
} from "../settings/model";

export interface SettingsViewProps {
  readonly initial: SettingsDraft;
  /** Endpoint each store holds a token for; leaving the field empty keeps a matching one. */
  readonly storedEndpoints: Readonly<Record<CredentialStorage, string | null>>;
  /** Validates and saves; resolves to field errors, or null on success. */
  readonly onSave: (draft: SettingsDraft) => Promise<DraftErrors | null>;
  readonly onRemoveCredentials: () => Promise<void>;
  readonly onCancel: (() => void) | null;
  readonly onOpenDemo: () => void;
  readonly onOpenLiveDemo: () => void;
}

export function SettingsView(props: SettingsViewProps) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(props.initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);
  const storedFor = props.storedEndpoints[draft.credentialStorage];
  const stored = storedFor !== null && storedFor === savedForm(draft.endpoint);
  const anyStored = Object.values(props.storedEndpoints).some((endpoint) => endpoint !== null);
  const hostname = typeof window === "undefined" ? "" : window.location.hostname;

  const update = (field: keyof SettingsDraft) => (value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    setSaving(true);
    props
      .onSave(draft)
      .then((result) => {
        setErrors(result ?? {});
      })
      .catch(() => {
        setErrors({ token: "settings.saveFailed" });
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const field = (name: keyof SettingsDraft, label: string, input: ReactNode, hint?: string) => (
    <label className="field">
      <span>{label}</span>
      {input}
      {hint !== undefined && <small>{hint}</small>}
      {errors[name] !== undefined && (
        <small className="field-error" role="alert">
          {t(errors[name])}
        </small>
      )}
    </label>
  );

  return (
    <form className="settings" onSubmit={submit} autoComplete="off">
      <h1>{t("settings.title")}</h1>
      {field(
        "platform",
        t("settings.platform"),
        <select
          value={draft.platform}
          onChange={(event) => {
            update("platform")(event.target.value);
          }}
        >
          <option value="github">{t("settings.github")}</option>
          <option value="gitlab" disabled>
            {t("settings.gitlab")}
          </option>
        </select>,
      )}
      {field(
        "endpoint",
        t("settings.endpoint"),
        <input
          type="url"
          value={draft.endpoint}
          onChange={(event) => {
            update("endpoint")(event.target.value);
          }}
        />,
        t("settings.endpointHint"),
      )}
      {field(
        "repository",
        t("settings.repository"),
        <input
          type="text"
          placeholder={t("settings.repositoryPlaceholder")}
          value={draft.repository}
          onChange={(event) => {
            update("repository")(event.target.value);
          }}
        />,
      )}
      {field(
        "branch",
        t("settings.branch"),
        <input
          type="text"
          placeholder={t("settings.branchPlaceholder")}
          value={draft.branch}
          onChange={(event) => {
            update("branch")(event.target.value);
          }}
        />,
      )}
      {field(
        "selfNames",
        t("settings.myNames"),
        <input
          type="text"
          placeholder={t("settings.myNamesPlaceholder")}
          value={draft.selfNames}
          onChange={(event) => {
            update("selfNames")(event.target.value);
          }}
        />,
        t("settings.myNamesHint"),
      )}
      {field(
        "token",
        t("settings.token"),
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={stored ? t("settings.tokenStored") : ""}
          value={draft.token}
          onChange={(event) => {
            update("token")(event.target.value);
          }}
        />,
        t("settings.tokenHint"),
      )}
      <p className="note">{t("settings.encryptedHint")}</p>
      <fieldset className="field">
        <legend>{t("settings.keep")}</legend>
        {(["memory", "browser-encrypted"] as const).map((kind: CredentialStorage) => (
          <label key={kind} className="choice">
            <input
              type="radio"
              name="credentialStorage"
              checked={draft.credentialStorage === kind}
              onChange={() => {
                update("credentialStorage")(kind);
              }}
            />
            {kind === "memory" ? t("settings.memory") : t("settings.encrypted")}
          </label>
        ))}
        <small className="warning">
          {storageWarning(draft.credentialStorage, hostname)
            .map((key) => t(key))
            .join(" ")}
        </small>
      </fieldset>
      <div className="actions">
        <button type="submit" disabled={saving}>
          {t("settings.saveOpen")}
        </button>
        {props.onCancel !== null && (
          <button type="button" disabled={saving} onClick={props.onCancel}>
            {t("settings.cancel")}
          </button>
        )}
        {anyStored && (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              props.onRemoveCredentials().catch(() => {
                setErrors({ token: "settings.removeFailed" });
              });
            }}
          >
            {t("settings.remove")}
          </button>
        )}
        <button type="button" disabled={saving} onClick={props.onOpenDemo}>
          {t("settings.openOffline")}
        </button>
        <button type="button" disabled={saving} onClick={props.onOpenLiveDemo}>
          {t("welcome.openLiveDemo")}
        </button>
      </div>
    </form>
  );
}

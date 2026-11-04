// Settings screen. Secret inputs are masked, never prefilled and never echoed back.

import { useLocale } from "../i18n/LocaleProvider";
import { useEffect, useId, useRef, useState, type ReactNode, type SubmitEvent } from "react";

import {
  savedForm,
  storageWarning,
  type CredentialStorage,
  type DraftErrors,
  type SettingsDraft,
} from "../settings/model";
import { DEMO_REPOSITORY } from "../settings/live-demo";
import { PLAIN_TOKEN_URL, tokenCreationUrl } from "../settings/token-link";

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
  /** Scroll to the token section and focus its field when the screen opens. */
  readonly focusToken?: boolean;
}

/** Accessibility attributes the field gives its control. */
interface FieldAria {
  readonly id: string;
  readonly "aria-describedby": string | undefined;
  readonly "aria-invalid": true | undefined;
}

export function SettingsView(props: SettingsViewProps) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(props.initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);
  const storedFor = props.storedEndpoints[draft.credentialStorage];
  const stored = storedFor !== null && storedFor === savedForm(draft.endpoint);
  const anyStored = Object.values(props.storedEndpoints).some((endpoint) => endpoint !== null);
  const tokenInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (props.focusToken !== true) return;
    // scrollIntoView is missing in some test DOMs.
    if (typeof tokenInput.current?.scrollIntoView === "function") {
      tokenInput.current.scrollIntoView({ block: "center" });
    }
    tokenInput.current?.focus();
    // Only when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const createUrl = tokenCreationUrl({
    endpoint: draft.endpoint,
    repository: draft.repository,
    // The demo repository is public; any other repository may be private.
    privateAccess: draft.repository !== "" && draft.repository !== DEMO_REPOSITORY,
    name: t("settings.tokenName"),
    description: t("settings.tokenDescription"),
  });
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

  const ids = useId();
  /**
   * A field with its label, hint and error. The hint and the error sit outside the label, so the
   * field's accessible name is the label alone; the input points at them with aria-describedby
   * and carries aria-invalid while it has an error.
   */
  const field = (
    name: keyof SettingsDraft,
    label: string,
    input: (aria: FieldAria) => ReactNode,
    hint?: string,
  ) => {
    const id = `${ids}-${name}`;
    const error = errors[name];
    const described = [
      hint !== undefined ? `${id}-hint` : null,
      error !== undefined ? `${id}-error` : null,
    ].filter((value) => value !== null);
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        {input({
          id,
          "aria-describedby": described.length > 0 ? described.join(" ") : undefined,
          "aria-invalid": error !== undefined ? true : undefined,
        })}
        {hint !== undefined && <small id={`${id}-hint`}>{hint}</small>}
        {error !== undefined && (
          <small id={`${id}-error`} className="field-error" role="alert">
            {t(error)}
          </small>
        )}
      </div>
    );
  };

  return (
    <form className="settings" onSubmit={submit} autoComplete="off">
      <h2>{t("settings.title")}</h2>
      {field("platform", t("settings.platform"), (aria) => (
        <select
          {...aria}
          value={draft.platform}
          onChange={(event) => {
            update("platform")(event.target.value);
          }}
        >
          <option value="github">{t("settings.github")}</option>
          <option value="gitlab" disabled>
            {t("settings.gitlab")}
          </option>
        </select>
      ))}
      {field(
        "endpoint",
        t("settings.endpoint"),
        (aria) => (
          <input
            {...aria}
            type="url"
            value={draft.endpoint}
            onChange={(event) => {
              update("endpoint")(event.target.value);
            }}
          />
        ),
        t("settings.endpointHint"),
      )}
      {field("repository", t("settings.repository"), (aria) => (
        <input
          {...aria}
          type="text"
          placeholder={t("settings.repositoryPlaceholder")}
          value={draft.repository}
          onChange={(event) => {
            update("repository")(event.target.value);
          }}
        />
      ))}
      {field("branch", t("settings.branch"), (aria) => (
        <input
          {...aria}
          type="text"
          placeholder={t("settings.branchPlaceholder")}
          value={draft.branch}
          onChange={(event) => {
            update("branch")(event.target.value);
          }}
        />
      ))}
      {field(
        "selfNames",
        t("settings.myNames"),
        (aria) => (
          <input
            {...aria}
            type="text"
            placeholder={t("settings.myNamesPlaceholder")}
            value={draft.selfNames}
            onChange={(event) => {
              update("selfNames")(event.target.value);
            }}
          />
        ),
        t("settings.myNamesHint"),
      )}
      <section id="token-section" className="token-help">
        <p>{t("settings.tokenWhy")}</p>
        <p>{t("settings.tokenPublic")}</p>
        <p>{t("settings.tokenPrivate")}</p>
        {createUrl !== null && (
          <p className="token-links">
            <a href={createUrl} target="_blank" rel="noopener noreferrer">
              {t("settings.tokenCreate")}
            </a>{" "}
            <a href={PLAIN_TOKEN_URL} target="_blank" rel="noopener noreferrer">
              {t("settings.tokenCreatePlain")}
            </a>
          </p>
        )}
      </section>
      {field(
        "token",
        t("settings.token"),
        (aria) => (
          <input
            {...aria}
            ref={tokenInput}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={stored ? t("settings.tokenStored") : ""}
            value={draft.token}
            onChange={(event) => {
              update("token")(event.target.value);
            }}
          />
        ),
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

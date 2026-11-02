// Settings screen. Secret inputs are masked, never prefilled and never echoed back.

import { useState, type ReactNode, type SubmitEvent } from "react";

import {
  STORAGE_WARNINGS,
  type CredentialStorage,
  type DraftErrors,
  type SettingsDraft,
} from "../settings/model";

export interface SettingsViewProps {
  readonly initial: SettingsDraft;
  /** A token is already stored; leaving the field empty keeps it. */
  readonly tokenStored: boolean;
  /** Validates and saves; resolves to field errors, or null on success. */
  readonly onSave: (draft: SettingsDraft) => Promise<DraftErrors | null>;
  readonly onRemoveCredentials: () => Promise<void>;
  readonly onCancel: (() => void) | null;
  readonly onOpenDemo: () => void;
}

export function SettingsView(props: SettingsViewProps) {
  const [draft, setDraft] = useState(props.initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);

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
        setErrors({ token: "Could not save the credential." });
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
          {errors[name]}
        </small>
      )}
    </label>
  );

  return (
    <form className="settings" onSubmit={submit} autoComplete="off">
      <h1>Settings</h1>
      {field(
        "platform",
        "Platform",
        <select
          value={draft.platform}
          onChange={(event) => {
            update("platform")(event.target.value);
          }}
        >
          <option value="github">GitHub</option>
          <option value="gitlab" disabled>
            GitLab (later)
          </option>
        </select>,
      )}
      {field(
        "endpoint",
        "API endpoint",
        <input
          type="url"
          value={draft.endpoint}
          onChange={(event) => {
            update("endpoint")(event.target.value);
          }}
        />,
        "https://api.github.com, or https://<host>/api/v3 for GitHub Enterprise Server.",
      )}
      {field(
        "repository",
        "Repository",
        <input
          type="text"
          placeholder="owner/repository"
          value={draft.repository}
          onChange={(event) => {
            update("repository")(event.target.value);
          }}
        />,
      )}
      {field(
        "branch",
        "Branch",
        <input
          type="text"
          placeholder="default branch"
          value={draft.branch}
          onChange={(event) => {
            update("branch")(event.target.value);
          }}
        />,
      )}
      {field(
        "selfNames",
        "My names",
        <input
          type="text"
          placeholder="alice, alice-agent"
          value={draft.selfNames}
          onChange={(event) => {
            update("selfNames")(event.target.value);
          }}
        />,
        "Messages from these senders are shown on the right.",
      )}
      {field(
        "token",
        "Access token",
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={props.tokenStored ? "stored; leave empty to keep it" : ""}
          value={draft.token}
          onChange={(event) => {
            update("token")(event.target.value);
          }}
        />,
        "A fine-grained token for this one repository with Contents: read-only.",
      )}
      {field(
        "privateKey",
        "Private key (optional)",
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft.privateKey}
          onChange={(event) => {
            update("privateKey")(event.target.value);
          }}
        />,
        "An age identity for encrypted messages. Decryption arrives in a later version.",
      )}
      <fieldset className="field">
        <legend>Keep credentials</legend>
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
            {kind === "memory" ? "In memory only" : "Encrypted in this browser"}
          </label>
        ))}
        <small className="warning">{STORAGE_WARNINGS[draft.credentialStorage]}</small>
      </fieldset>
      <div className="actions">
        <button type="submit" disabled={saving}>
          Save and open
        </button>
        {props.onCancel !== null && (
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
        {props.tokenStored && (
          <button
            type="button"
            onClick={() => {
              void props.onRemoveCredentials();
            }}
          >
            Remove stored credentials
          </button>
        )}
        <button type="button" onClick={props.onOpenDemo}>
          Open demo repository
        </button>
      </div>
    </form>
  );
}

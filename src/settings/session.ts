// Applies the settings screen to storage: non-secret settings to local storage,
// secrets to exactly one credential store.

import type { Secret } from "../credentials/secret";
import type { CredentialStore } from "../credentials/store";
import {
  loadSettings,
  saveSettings,
  validateDraft,
  type CredentialStorage,
  type DraftErrors,
  type SettingsDraft,
  type ViewerSettings,
} from "./model";

export interface SettingsDeps {
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly stores: Readonly<Record<CredentialStorage, CredentialStore>>;
}

export interface OpenSettings {
  readonly settings: ViewerSettings;
  readonly token: Secret;
}

/** Saved settings and their token, or null when setup is incomplete. */
export async function restore(deps: SettingsDeps): Promise<OpenSettings | null> {
  const settings = loadSettings(deps.storage);
  if (settings === null) return null;
  const token = await deps.stores[settings.credentialStorage].get("access-token");
  return token === null ? null : { settings, token };
}

export async function tokenStored(
  deps: SettingsDeps,
  storage: CredentialStorage,
): Promise<boolean> {
  return (await deps.stores[storage].get("access-token")) !== null;
}

export async function apply(
  deps: SettingsDeps,
  draft: SettingsDraft,
): Promise<{ ok: true; open: OpenSettings } | { ok: false; errors: DraftErrors }> {
  const store = deps.stores[draft.credentialStorage];
  const result = validateDraft(draft, {
    tokenStored: await tokenStored(deps, draft.credentialStorage),
  });
  if (!result.ok) return result;
  for (const [kind, other] of Object.entries(deps.stores)) {
    if (kind !== draft.credentialStorage) await clear(other);
  }
  if (result.token !== null) await store.set("access-token", result.token);
  if (result.privateKey !== null) await store.set("private-key", result.privateKey);
  saveSettings(deps.storage, result.settings);
  const token = await store.get("access-token");
  if (token === null) return { ok: false, errors: { token: "Enter a read-only access token." } };
  return { ok: true, open: { settings: result.settings, token } };
}

export async function removeCredentials(deps: SettingsDeps): Promise<void> {
  for (const store of Object.values(deps.stores)) await clear(store);
}

async function clear(store: CredentialStore): Promise<void> {
  await store.delete("access-token");
  await store.delete("private-key");
}

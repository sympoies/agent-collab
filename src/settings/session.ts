import type { MessageKey } from "../i18n/catalog";
// Applies the settings screen to storage: non-secret settings to local storage,
// the token to exactly one credential store, bound to the endpoint it is for.

import { Secret } from "../credentials/secret";
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

interface StoredToken {
  readonly endpoint: string;
  readonly token: Secret;
}

/**
 * The stored record carries the endpoint with the token, so a token is never
 * handed to another endpoint, whatever the order of storage writes.
 */
function tokenRecord(endpoint: string, token: Secret): Secret {
  return new Secret(JSON.stringify({ endpoint, token: token.reveal() }));
}

/** The stored token, or null when missing, unreadable or the store fails. */
async function readToken(store: CredentialStore): Promise<StoredToken | null> {
  try {
    const record = await store.get("access-token");
    if (record === null) return null;
    const value: unknown = JSON.parse(record.reveal());
    if (typeof value !== "object" || value === null) return null;
    const { endpoint, token } = value as Record<string, unknown>;
    if (typeof endpoint !== "string" || typeof token !== "string") return null;
    return { endpoint, token: new Secret(token) };
  } catch {
    return null;
  }
}

/** Saved settings and their token, or null when setup is incomplete. */
export async function restore(deps: SettingsDeps): Promise<OpenSettings | null> {
  const settings = loadSettings(deps.storage);
  if (settings === null) return null;
  const stored = await readToken(deps.stores[settings.credentialStorage]);
  if (stored?.endpoint !== settings.endpoint) return null;
  return { settings, token: stored.token };
}

/** The endpoint each store holds a token for, or null when it holds none. */
export async function storedEndpoints(
  deps: SettingsDeps,
): Promise<Record<CredentialStorage, string | null>> {
  const [memory, encrypted] = await Promise.all([
    readToken(deps.stores.memory),
    readToken(deps.stores["browser-encrypted"]),
  ]);
  return { memory: memory?.endpoint ?? null, "browser-encrypted": encrypted?.endpoint ?? null };
}

export async function apply(
  deps: SettingsDeps,
  draft: SettingsDraft,
): Promise<
  { ok: true; open: OpenSettings; warning: MessageKey | null } | { ok: false; errors: DraftErrors }
> {
  const store = deps.stores[draft.credentialStorage];
  const stored = await readToken(store);
  const result = validateDraft(draft, {
    tokenStored: stored !== null,
    savedEndpoint: stored?.endpoint ?? null,
  });
  if (!result.ok) return result;
  const token = result.token ?? stored?.token;
  if (token === undefined) return { ok: false, errors: { token: "settings.error.tokenMissing" } };
  let warning: MessageKey | null = null;
  for (const [kind, other] of Object.entries(deps.stores)) {
    if (kind !== draft.credentialStorage && !(await clear(other))) {
      warning = "settings.oldCopyWarning";
    }
  }
  if (result.token !== null) {
    await store.set("access-token", tokenRecord(result.settings.endpoint, result.token));
  }
  saveSettings(deps.storage, result.settings);
  return { ok: true, open: { settings: result.settings, token }, warning };
}

/** Clears every store; rejects after trying all of them if one could not be cleared. */
export async function removeCredentials(deps: SettingsDeps): Promise<void> {
  const cleared = await Promise.all(Object.values(deps.stores).map(clear));
  if (cleared.includes(false)) throw new Error("Stored credentials could not be removed.");
}

async function clear(store: CredentialStore): Promise<boolean> {
  try {
    await store.delete("access-token");
    return true;
  } catch {
    return false;
  }
}

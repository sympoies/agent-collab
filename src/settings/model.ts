// Settings screen model (docs/design.md, section 6). Settings hold only
// non-secret values; the token goes to a CredentialStore.

import { Secret } from "../credentials/secret";

export type Platform = "github" | "gitlab";

/** Where the browser build keeps secrets; packaged builds use the OS keychain. */
export type CredentialStorage = "memory" | "browser-encrypted";

export interface ViewerSettings {
  readonly platform: Platform;
  /** API base URL without a trailing slash. */
  readonly endpoint: string;
  /** "owner/repository". */
  readonly repository: string;
  /** Branch to watch; "" uses the default branch. */
  readonly branch: string;
  /** Senders shown on the end side of the chat. */
  readonly selfNames: readonly string[];
  readonly credentialStorage: CredentialStorage;
}

/** Form state of the settings screen. Secret fields are never prefilled. */
export interface SettingsDraft {
  readonly platform: Platform;
  readonly endpoint: string;
  readonly repository: string;
  readonly branch: string;
  /** Comma-separated. */
  readonly selfNames: string;
  readonly credentialStorage: CredentialStorage;
  readonly token: string;
}

export type DraftErrors = Partial<Record<keyof SettingsDraft, string>>;

export type ValidationResult =
  | {
      readonly ok: true;
      readonly settings: ViewerSettings;
      /** New token, or null to keep the stored one. */
      readonly token: Secret | null;
    }
  | { readonly ok: false; readonly errors: DraftErrors };

export const STORAGE_WARNINGS: Readonly<Record<CredentialStorage, string>> = {
  memory: "The token stays in memory for this tab only. You will enter it again after a reload.",
  "browser-encrypted":
    "The token is encrypted and stored for this site in this browser profile. This avoids a " +
    "plain-text token in site storage, but a copy of this browser profile, scripts on this " +
    "site, or anyone using this profile can still use it. Sites sharing this origin can access " +
    "both the encrypted token and its key.",
};

export function storageWarning(storage: CredentialStorage, hostname: string): string {
  const warning = STORAGE_WARNINGS[storage];
  if (storage !== "browser-encrypted" || !hostname.endsWith(".github.io")) return warning;
  return (
    `${warning} Sibling GitHub Pages projects under the same account share this origin and can ` +
    "access the saved token and key. Prefer In memory only. A dedicated custom domain removes " +
    "this sibling-project exposure."
  );
}

export const DEFAULT_DRAFT: SettingsDraft = {
  platform: "github",
  endpoint: "https://api.github.com",
  repository: "",
  branch: "",
  selfNames: "",
  credentialStorage: "memory",
  token: "",
};

const NAME_RE = /^[a-z0-9-]+$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Git ref rules that matter for a typed branch name.
const BRANCH_RE = /^(?!\/)(?!.*\/$)(?!.*\.\.)[^\s~^:?*[\\]+$/;
const SETTINGS_KEY = "agent-collab-viewer.settings";

function splitNames(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

function normalizeEndpoint(value: string, errors: DraftErrors): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    errors.endpoint = "Use an https:// URL.";
    return "";
  }
  if (url.protocol !== "https:") {
    errors.endpoint = "Use an https:// URL.";
  } else if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    errors.endpoint = "Do not put credentials, query or fragment in the endpoint.";
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** The endpoint as the settings screen saves it, or null when it is not valid. */
export function savedForm(endpoint: string): string | null {
  const errors: DraftErrors = {};
  const normalized = normalizeEndpoint(endpoint, errors);
  return errors.endpoint === undefined ? normalized : null;
}

export interface DraftContext {
  /** A token is stored in the chosen credential store. */
  readonly tokenStored: boolean;
  /** Endpoint the stored token was saved for; a stored token is only reused for it. */
  readonly savedEndpoint: string | null;
}

export function validateDraft(draft: SettingsDraft, context: DraftContext): ValidationResult {
  const errors: DraftErrors = {};
  if (draft.platform !== "github") errors.platform = "GitLab support is not available yet.";
  const endpoint = normalizeEndpoint(draft.endpoint, errors);
  const repository = draft.repository.trim();
  if (!REPOSITORY_RE.test(repository)) errors.repository = "Use the form owner/repository.";
  const branch = draft.branch.trim();
  if (branch !== "" && !BRANCH_RE.test(branch)) errors.branch = "This is not a valid branch name.";
  const selfNames = splitNames(draft.selfNames);
  if (selfNames.some((name) => !NAME_RE.test(name))) {
    errors.selfNames = "Names are lowercase letters, digits and hyphens.";
  }
  const token = draft.token.trim();
  if (token === "" && !context.tokenStored) errors.token = "Enter a read-only access token.";
  else if (token === "" && endpoint !== context.savedEndpoint) {
    errors.token = "Enter the token for this endpoint.";
  } else if (/\s/.test(token)) errors.token = "A token has no spaces.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      platform: draft.platform,
      endpoint,
      repository,
      branch,
      selfNames,
      credentialStorage: draft.credentialStorage,
    },
    token: token === "" ? null : new Secret(token),
  };
}

export function draftFromSettings(settings: ViewerSettings): SettingsDraft {
  return {
    platform: settings.platform,
    endpoint: settings.endpoint,
    repository: settings.repository,
    branch: settings.branch,
    selfNames: settings.selfNames.join(", "),
    credentialStorage: settings.credentialStorage,
    token: "",
  };
}

function isSettings(value: unknown): value is ViewerSettings {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.platform === "github" || v.platform === "gitlab") &&
    typeof v.endpoint === "string" &&
    typeof v.repository === "string" &&
    typeof v.branch === "string" &&
    Array.isArray(v.selfNames) &&
    v.selfNames.every((name) => typeof name === "string") &&
    (v.credentialStorage === "memory" || v.credentialStorage === "browser-encrypted")
  );
}

/** Stored settings pass the same endpoint and repository rules as the settings screen. */
function isValid(settings: ViewerSettings): boolean {
  const errors: DraftErrors = {};
  return (
    normalizeEndpoint(settings.endpoint, errors) === settings.endpoint &&
    errors.endpoint === undefined &&
    REPOSITORY_RE.test(settings.repository)
  );
}

/** Reads non-secret settings; null when missing, invalid or storage is blocked. */
export function loadSettings(storage: Pick<Storage, "getItem">): ViewerSettings | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(SETTINGS_KEY) ?? "null");
    return isSettings(value) && isValid(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveSettings(storage: Pick<Storage, "setItem">, settings: ViewerSettings): void {
  const { platform, endpoint, repository, branch, selfNames, credentialStorage } = settings;
  storage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ platform, endpoint, repository, branch, selfNames, credentialStorage }),
  );
}

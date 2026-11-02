// Settings screen model (docs/design.md, section 6). Settings hold only
// non-secret values; the token and private key go to a CredentialStore.

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
  readonly privateKey: string;
}

export type DraftErrors = Partial<Record<keyof SettingsDraft, string>>;

export type ValidationResult =
  | {
      readonly ok: true;
      readonly settings: ViewerSettings;
      /** New token, or null to keep the stored one. */
      readonly token: Secret | null;
      /** New private key, or null to keep the stored one (if any). */
      readonly privateKey: Secret | null;
    }
  | { readonly ok: false; readonly errors: DraftErrors };

export const STORAGE_WARNINGS: Readonly<Record<CredentialStorage, string>> = {
  memory: "The token stays in memory for this tab only. You will enter it again after a reload.",
  "browser-encrypted":
    "The token is encrypted with a key that cannot leave this browser and stored for this site. " +
    "This prevents plain-text copies, but scripts on this site and anyone using this browser " +
    "profile can still use it.",
};

export const DEFAULT_DRAFT: SettingsDraft = {
  platform: "github",
  endpoint: "https://api.github.com",
  repository: "",
  branch: "",
  selfNames: "",
  credentialStorage: "memory",
  token: "",
  privateKey: "",
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

export function validateDraft(
  draft: SettingsDraft,
  context: { readonly tokenStored: boolean },
): ValidationResult {
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
  else if (/\s/.test(token)) errors.token = "A token has no spaces.";
  const privateKey = draft.privateKey.trim();
  if (privateKey !== "" && !privateKey.startsWith("AGE-SECRET-KEY-1")) {
    errors.privateKey = "Use an age identity starting with AGE-SECRET-KEY-1.";
  }
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
    privateKey: privateKey === "" ? null : new Secret(privateKey),
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
    privateKey: "",
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

/** Reads non-secret settings; null when missing, invalid or storage is blocked. */
export function loadSettings(storage: Pick<Storage, "getItem">): ViewerSettings | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(SETTINGS_KEY) ?? "null");
    return isSettings(value) ? value : null;
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

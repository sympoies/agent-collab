import { describe, expect, it } from "vitest";

import { Secret } from "../src/credentials/secret";
import {
  DEFAULT_DRAFT,
  draftFromSettings,
  loadSettings,
  saveSettings,
  validateDraft,
  type SettingsDraft,
  type ViewerSettings,
} from "../src/settings/model";

const TOKEN = "test-token-not-real";

const draft = (overrides: Partial<SettingsDraft> = {}): SettingsDraft => ({
  ...DEFAULT_DRAFT,
  repository: "alice-org/collab",
  token: TOKEN,
  ...overrides,
});

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("validateDraft", () => {
  it("accepts a GitHub repository and wraps the secrets", () => {
    const result = validateDraft(draft({ selfNames: "alice-agent, alice", branch: "main" }), {
      tokenStored: false,
      savedEndpoint: null,
    });
    expect(result).toEqual({
      ok: true,
      settings: {
        platform: "github",
        endpoint: "https://api.github.com",
        repository: "alice-org/collab",
        branch: "main",
        selfNames: ["alice-agent", "alice"],
        credentialStorage: "memory",
      },
      token: new Secret(TOKEN),
    });
    if (result.ok) expect(result.token?.reveal()).toBe(TOKEN);
  });

  it("keeps a stored token when the token field is left empty", () => {
    const result = validateDraft(draft({ token: "" }), {
      tokenStored: true,
      savedEndpoint: "https://api.github.com",
    });
    expect(result).toMatchObject({ ok: true, token: null });
  });

  it("removes a trailing slash from the endpoint", () => {
    const result = validateDraft(draft({ endpoint: "https://github.example.com/api/v3/" }), {
      tokenStored: false,
      savedEndpoint: null,
    });
    expect(result).toMatchObject({
      ok: true,
      settings: { endpoint: "https://github.example.com/api/v3" },
    });
  });

  it.each<[string, Partial<SettingsDraft>, Partial<Record<keyof SettingsDraft, string>>]>([
    [
      "GitLab before it is supported",
      { platform: "gitlab" },
      { platform: "settings.error.gitlab" },
    ],
    [
      "a plain HTTP endpoint",
      { endpoint: "http://api.github.example" },
      { endpoint: "settings.error.https" },
    ],
    [
      "an endpoint that is not a URL",
      { endpoint: "api.github.com" },
      { endpoint: "settings.error.https" },
    ],
    [
      "an endpoint with embedded credentials",
      { endpoint: "https://user:pass@api.github.example" },
      { endpoint: "settings.error.endpointParts" },
    ],
    [
      "an endpoint with a query",
      { endpoint: "https://api.github.example/?access_token=x" },
      { endpoint: "settings.error.endpointParts" },
    ],
    [
      "a repository without owner",
      { repository: "collab" },
      { repository: "settings.error.repository" },
    ],
    [
      "a repository with a path",
      { repository: "a/b/c" },
      { repository: "settings.error.repository" },
    ],
    ["a branch with spaces", { branch: "my branch" }, { branch: "settings.error.branch" }],
    ["a branch with ..", { branch: "a..b" }, { branch: "settings.error.branch" }],
    ["an invalid name", { selfNames: "Alice" }, { selfNames: "settings.error.names" }],
    ["a missing token", { token: "" }, { token: "settings.error.tokenMissing" }],
    ["a token with spaces", { token: "two words" }, { token: "settings.error.tokenSpaces" }],
  ])("rejects %s", (_name, overrides, errors) => {
    expect(validateDraft(draft(overrides), { tokenStored: false, savedEndpoint: null })).toEqual({
      ok: false,
      errors,
    });
  });
});

describe("settings persistence", () => {
  const settings: ViewerSettings = {
    platform: "github",
    endpoint: "https://api.github.com",
    repository: "alice-org/collab",
    branch: "",
    selfNames: ["alice-agent"],
    credentialStorage: "browser-encrypted",
  };

  it("round-trips non-secret settings", () => {
    const storage = fakeStorage();
    saveSettings(storage, settings);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it("returns null for missing or invalid stored settings", () => {
    expect(loadSettings(fakeStorage())).toBeNull();
    expect(loadSettings(fakeStorage({ "agent-collab-viewer.settings": "{" }))).toBeNull();
    expect(
      loadSettings(
        fakeStorage({ "agent-collab-viewer.settings": JSON.stringify({ platform: "x" }) }),
      ),
    ).toBeNull();
  });

  it.each([
    ["a plain HTTP endpoint", { endpoint: "http://api.github.example" }],
    ["an endpoint with a query", { endpoint: "https://api.github.example/?access_token=x" }],
    ["an endpoint with credentials", { endpoint: "https://user:pass@api.github.example" }],
    ["a repository with a path", { repository: "a/b/c" }],
    ["a repository without owner", { repository: "collab" }],
  ])("rejects stored settings with %s", (_name, overrides) => {
    const stored = JSON.stringify({ ...settings, ...overrides });
    expect(loadSettings(fakeStorage({ "agent-collab-viewer.settings": stored }))).toBeNull();
  });

  it("turns settings back into a draft without secrets", () => {
    expect(draftFromSettings(settings)).toEqual({
      platform: "github",
      endpoint: "https://api.github.com",
      repository: "alice-org/collab",
      branch: "",
      selfNames: "alice-agent",
      credentialStorage: "browser-encrypted",
      token: "",
    });
  });

  it("returns null when storage is unavailable", () => {
    const storage = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };
    expect(loadSettings(storage)).toBeNull();
  });
});

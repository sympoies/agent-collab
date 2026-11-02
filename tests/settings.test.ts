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
    const result = validateDraft(
      draft({ selfNames: "alice-agent, alice", branch: "main", privateKey: "AGE-SECRET-KEY-1ABC" }),
      { tokenStored: false },
    );
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
      privateKey: new Secret("AGE-SECRET-KEY-1ABC"),
    });
    if (result.ok) expect(result.token?.reveal()).toBe(TOKEN);
  });

  it("keeps a stored token when the token field is left empty", () => {
    const result = validateDraft(draft({ token: "" }), { tokenStored: true });
    expect(result).toMatchObject({ ok: true, token: null, privateKey: null });
  });

  it("removes a trailing slash from the endpoint", () => {
    const result = validateDraft(draft({ endpoint: "https://github.example.com/api/v3/" }), {
      tokenStored: false,
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
      { platform: "GitLab support is not available yet." },
    ],
    [
      "a plain HTTP endpoint",
      { endpoint: "http://api.github.example" },
      { endpoint: "Use an https:// URL." },
    ],
    [
      "an endpoint that is not a URL",
      { endpoint: "api.github.com" },
      { endpoint: "Use an https:// URL." },
    ],
    [
      "an endpoint with embedded credentials",
      { endpoint: "https://user:pass@api.github.example" },
      { endpoint: "Do not put credentials, query or fragment in the endpoint." },
    ],
    [
      "an endpoint with a query",
      { endpoint: "https://api.github.example/?access_token=x" },
      { endpoint: "Do not put credentials, query or fragment in the endpoint." },
    ],
    [
      "a repository without owner",
      { repository: "collab" },
      { repository: "Use the form owner/repository." },
    ],
    [
      "a repository with a path",
      { repository: "a/b/c" },
      { repository: "Use the form owner/repository." },
    ],
    [
      "a branch with spaces",
      { branch: "my branch" },
      { branch: "This is not a valid branch name." },
    ],
    ["a branch with ..", { branch: "a..b" }, { branch: "This is not a valid branch name." }],
    [
      "an invalid name",
      { selfNames: "Alice" },
      { selfNames: "Names are lowercase letters, digits and hyphens." },
    ],
    ["a missing token", { token: "" }, { token: "Enter a read-only access token." }],
    ["a token with spaces", { token: "two words" }, { token: "A token has no spaces." }],
    [
      "a private key in the wrong format",
      { privateKey: "ssh-ed25519 AAAA" },
      { privateKey: "Use an age identity starting with AGE-SECRET-KEY-1." },
    ],
  ])("rejects %s", (_name, overrides, errors) => {
    expect(validateDraft(draft(overrides), { tokenStored: false })).toEqual({ ok: false, errors });
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

  it("turns settings back into a draft without secrets", () => {
    expect(draftFromSettings(settings)).toEqual({
      platform: "github",
      endpoint: "https://api.github.com",
      repository: "alice-org/collab",
      branch: "",
      selfNames: "alice-agent",
      credentialStorage: "browser-encrypted",
      token: "",
      privateKey: "",
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

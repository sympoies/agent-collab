import { describe, expect, it } from "vitest";

import type { Secret } from "../src/credentials/secret";
import { MemoryStore, type CredentialStore } from "../src/credentials/store";
import { DEFAULT_DRAFT, type SettingsDraft } from "../src/settings/model";
import { apply, removeCredentials, restore, storedEndpoints } from "../src/settings/session";

const TOKEN = "test-token-not-real";
const OTHER_TOKEN = "other-token-not-real";
const ENTERPRISE = "https://github.example.com/api/v3";

function deps() {
  const data = new Map<string, string>();
  let failWrites = false;
  return {
    data,
    failWrites: () => {
      failWrites = true;
    },
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites) throw new Error("quota exceeded");
        data.set(key, value);
      },
    },
    stores: {
      memory: new MemoryStore() as CredentialStore,
      "browser-encrypted": new MemoryStore() as CredentialStore,
    },
  };
}

/** A store whose every operation rejects, like a blocked IndexedDB. */
const broken: CredentialStore = {
  get: () => Promise.reject(new Error("storage blocked")),
  set: () => Promise.reject(new Error("storage blocked")),
  delete: () => Promise.reject(new Error("storage blocked")),
};

const draft = (overrides: Partial<SettingsDraft> = {}): SettingsDraft => ({
  ...DEFAULT_DRAFT,
  repository: "alice-org/collab",
  token: TOKEN,
  ...overrides,
});

const reveal = (secret: Secret | null | undefined) => secret?.reveal();

describe("settings session", () => {
  it("saves settings without secrets and restores them with the token", async () => {
    const d = deps();
    const result = await apply(d, draft());
    expect(result).toMatchObject({
      ok: true,
      open: { settings: { repository: "alice-org/collab" } },
      warning: null,
    });
    expect([...d.data.values()].join("")).not.toContain(TOKEN);
    expect(reveal((await restore(d))?.token)).toBe(TOKEN);
  });

  it("keeps the stored token when the field is left empty", async () => {
    const d = deps();
    await apply(d, draft());
    const result = await apply(d, draft({ token: "", branch: "main" }));
    expect(result.ok && result.open.token.reveal()).toBe(TOKEN);
  });

  it("requires a new token when the endpoint changes", async () => {
    const d = deps();
    await apply(d, draft());
    expect(await apply(d, draft({ token: "", endpoint: ENTERPRISE }))).toEqual({
      ok: false,
      errors: { token: "settings.error.tokenEndpoint" },
    });
    expect((await restore(d))?.settings.endpoint).toBe("https://api.github.com");
  });

  it("never restores a token for an endpoint it was not saved with", async () => {
    const d = deps();
    await apply(d, draft());
    d.failWrites();
    await expect(apply(d, draft({ token: OTHER_TOKEN, endpoint: ENTERPRISE }))).rejects.toThrow(
      "quota exceeded",
    );
    expect(await restore(d)).toBeNull();
  });

  it("keeps secrets in exactly the chosen store", async () => {
    const d = deps();
    await apply(d, draft({ credentialStorage: "browser-encrypted" }));
    await apply(d, draft({ credentialStorage: "memory" }));
    expect(await d.stores["browser-encrypted"].get("access-token")).toBeNull();
    expect(await storedEndpoints(d)).toEqual({
      memory: "https://api.github.com",
      "browser-encrypted": null,
    });
  });

  it("requires a new token when switching stores", async () => {
    const d = deps();
    await apply(d, draft({ credentialStorage: "browser-encrypted" }));
    expect(await apply(d, draft({ credentialStorage: "memory", token: "" }))).toEqual({
      ok: false,
      errors: { token: "settings.error.tokenMissing" },
    });
  });

  it("stores nothing when the draft is invalid", async () => {
    const d = deps();
    expect(await apply(d, draft({ repository: "collab" }))).toMatchObject({ ok: false });
    expect(d.data.size).toBe(0);
    expect(await d.stores.memory.get("access-token")).toBeNull();
  });

  it("needs setup again after the credentials are removed", async () => {
    const d = deps();
    await apply(d, draft());
    await removeCredentials(d);
    expect(await restore(d)).toBeNull();
  });
});

describe("settings session with a failing credential store", () => {
  it("falls back to setup when the store cannot be read", async () => {
    const d = deps();
    await apply(d, draft({ credentialStorage: "browser-encrypted" }));
    d.stores["browser-encrypted"] = broken;
    expect(await restore(d)).toBeNull();
    expect(await storedEndpoints(d)).toEqual({ memory: null, "browser-encrypted": null });
  });

  it("saves and warns when the old copy cannot be removed", async () => {
    const d = deps();
    d.stores["browser-encrypted"] = broken;
    const result = await apply(d, draft({ credentialStorage: "memory" }));
    expect(result).toMatchObject({
      ok: true,
      warning: "settings.oldCopyWarning",
    });
    expect(reveal((await restore(d))?.token)).toBe(TOKEN);
  });

  it("removes what it can and reports a store it could not clear", async () => {
    const d = deps();
    await apply(d, draft({ credentialStorage: "browser-encrypted" }));
    const encrypted = d.stores["browser-encrypted"];
    d.stores.memory = broken;
    await expect(removeCredentials(d)).rejects.toThrow("could not be removed");
    expect(await encrypted.get("access-token")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { Secret } from "../src/credentials/secret";
import { MemoryStore } from "../src/credentials/store";
import { DEFAULT_DRAFT, type SettingsDraft } from "../src/settings/model";
import { apply, removeCredentials, restore } from "../src/settings/session";

const TOKEN = "test-token-not-real";

function deps() {
  const data = new Map<string, string>();
  return {
    data,
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    },
    stores: { memory: new MemoryStore(), "browser-encrypted": new MemoryStore() },
  };
}

const draft = (overrides: Partial<SettingsDraft> = {}): SettingsDraft => ({
  ...DEFAULT_DRAFT,
  repository: "alice-org/collab",
  token: TOKEN,
  ...overrides,
});

describe("settings session", () => {
  it("saves settings without secrets and restores them with the token", async () => {
    const d = deps();
    const result = await apply(d, draft({ privateKey: "AGE-SECRET-KEY-1ABC" }));
    expect(result).toMatchObject({
      ok: true,
      open: { settings: { repository: "alice-org/collab" } },
    });
    expect([...d.data.values()].join("")).not.toContain(TOKEN);
    expect([...d.data.values()].join("")).not.toContain("AGE-SECRET-KEY");
    expect((await restore(d))?.token.reveal()).toBe(TOKEN);
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
    expect(
      await apply(d, draft({ token: "", endpoint: "https://github.example.com/api/v3" })),
    ).toEqual({ ok: false, errors: { token: "Enter the token for this endpoint." } });
    expect((await restore(d))?.settings.endpoint).toBe("https://api.github.com");
  });

  it("keeps secrets in exactly the chosen store", async () => {
    const d = deps();
    await apply(d, draft({ credentialStorage: "browser-encrypted" }));
    await apply(d, draft({ credentialStorage: "memory" }));
    expect(await d.stores["browser-encrypted"].get("access-token")).toBeNull();
    expect((await d.stores.memory.get("access-token"))?.reveal()).toBe(TOKEN);
  });

  it("requires a new token when switching stores", async () => {
    const d = deps();
    await apply(d, draft({ credentialStorage: "browser-encrypted" }));
    expect(await apply(d, draft({ credentialStorage: "memory", token: "" }))).toEqual({
      ok: false,
      errors: { token: "Enter a read-only access token." },
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
    await d.stores.memory.set("private-key", new Secret("AGE-SECRET-KEY-1ABC"));
    await removeCredentials(d);
    expect(await restore(d)).toBeNull();
    expect(await d.stores.memory.get("private-key")).toBeNull();
  });
});

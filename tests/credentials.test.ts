import { describe, expect, it } from "vitest";

import { Secret } from "../src/credentials/secret";
import {
  BrowserEncryptedStore,
  MemoryStore,
  TauriKeychainStore,
  unavailableKeychain,
  type CredentialStore,
  type KeychainBridge,
  type RecordStore,
} from "../src/credentials/store";

const TOKEN = "test-token-not-real";

class MemoryRecords implements RecordStore {
  readonly data = new Map<string, unknown>();
  get(key: string): Promise<unknown> {
    return Promise.resolve(this.data.get(key));
  }
  put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}

class FakeKeychain implements KeychainBridge {
  readonly data = new Map<string, string>();
  get(name: string): Promise<string | null> {
    return Promise.resolve(this.data.get(name) ?? null);
  }
  set(name: string, value: string): Promise<void> {
    this.data.set(name, value);
    return Promise.resolve();
  }
  delete(name: string): Promise<void> {
    this.data.delete(name);
    return Promise.resolve();
  }
}

const stores: [string, () => CredentialStore][] = [
  ["memory", () => new MemoryStore()],
  ["browser-encrypted", () => new BrowserEncryptedStore(new MemoryRecords())],
  ["keychain", () => new TauriKeychainStore(new FakeKeychain())],
];

describe.each(stores)("%s credential store", (_kind, create) => {
  it("stores, reads and deletes each secret separately", async () => {
    const store = create();
    expect(await store.get("access-token")).toBeNull();
    await store.set("access-token", new Secret(TOKEN));
    await store.set("private-key", new Secret("AGE-SECRET-KEY-1ABC"));
    expect((await store.get("access-token"))?.reveal()).toBe(TOKEN);
    await store.delete("access-token");
    expect(await store.get("access-token")).toBeNull();
    expect((await store.get("private-key"))?.reveal()).toBe("AGE-SECRET-KEY-1ABC");
  });
});

describe("BrowserEncryptedStore", () => {
  it("keeps only ciphertext and a non-extractable key in storage", async () => {
    const records = new MemoryRecords();
    await new BrowserEncryptedStore(records).set("access-token", new Secret(TOKEN));
    const key = records.data.get("key");
    expect(key).toBeInstanceOf(CryptoKey);
    expect((key as CryptoKey).extractable).toBe(false);
    const serialized = JSON.stringify([...records.data.entries()], (_k, value: unknown) =>
      value instanceof Uint8Array ? Array.from(value) : value,
    );
    expect(serialized).not.toContain(TOKEN);
    const bytes = new TextEncoder().encode(TOKEN);
    const stored = records.data.get("secret:access-token") as { data: Uint8Array };
    expect(Buffer.from(stored.data).includes(Buffer.from(bytes))).toBe(false);
  });

  it("reads secrets written by an earlier session with the same key", async () => {
    const records = new MemoryRecords();
    await new BrowserEncryptedStore(records).set("access-token", new Secret(TOKEN));
    expect((await new BrowserEncryptedStore(records).get("access-token"))?.reveal()).toBe(TOKEN);
  });

  it("treats undecryptable records as missing", async () => {
    const records = new MemoryRecords();
    await new BrowserEncryptedStore(records).set("access-token", new Secret(TOKEN));
    records.data.delete("key");
    expect(await new BrowserEncryptedStore(records).get("access-token")).toBeNull();
  });
});

describe("TauriKeychainStore", () => {
  it("reports that the keychain is unavailable until the packaging slice", async () => {
    const store = new TauriKeychainStore(unavailableKeychain);
    await expect(store.get("access-token")).rejects.toThrow("keychain is not available");
  });
});

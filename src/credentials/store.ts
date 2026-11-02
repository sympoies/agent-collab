// Credential storage (docs/design.md, section 6). Secrets never go to settings,
// logs or URLs; each store only hands out Secret values.

import { Secret } from "./secret";

export type SecretName = "access-token" | "private-key";

export interface CredentialStore {
  get(name: SecretName): Promise<Secret | null>;
  set(name: SecretName, secret: Secret): Promise<void>;
  delete(name: SecretName): Promise<void>;
}

/** Keeps secrets for the page session only. */
export class MemoryStore implements CredentialStore {
  private readonly secrets = new Map<SecretName, Secret>();

  get(name: SecretName): Promise<Secret | null> {
    return Promise.resolve(this.secrets.get(name) ?? null);
  }

  set(name: SecretName, secret: Secret): Promise<void> {
    this.secrets.set(name, secret);
    return Promise.resolve();
  }

  delete(name: SecretName): Promise<void> {
    this.secrets.delete(name);
    return Promise.resolve();
  }
}

/** Structured-clone key-value storage (IndexedDB in the browser). */
export interface RecordStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface EncryptedRecord {
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly data: Uint8Array<ArrayBuffer>;
}

const KEY_RECORD = "key";

function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<EncryptedRecord>).iv instanceof Uint8Array &&
    (value as Partial<EncryptedRecord>).data instanceof Uint8Array
  );
}

/**
 * Encrypts secrets with AES-GCM under a non-extractable WebCrypto key. Key and
 * ciphertext stay in this origin's storage. Prevents plain-text copies of the
 * token; does not protect against script in the same origin.
 */
export class BrowserEncryptedStore implements CredentialStore {
  constructor(private readonly records: RecordStore) {}

  async get(name: SecretName): Promise<Secret | null> {
    const record = await this.records.get(`secret:${name}`);
    const key = await this.records.get(KEY_RECORD);
    if (!isEncryptedRecord(record) || !(key instanceof CryptoKey)) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: record.iv },
        key,
        record.data,
      );
      return new Secret(new TextDecoder().decode(plain));
    } catch {
      return null;
    }
  }

  async set(name: SecretName, secret: Secret): Promise<void> {
    const key = await this.key();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(secret.reveal()),
      ),
    );
    await this.records.put(`secret:${name}`, { iv, data } satisfies EncryptedRecord);
  }

  delete(name: SecretName): Promise<void> {
    return this.records.delete(`secret:${name}`);
  }

  private async key(): Promise<CryptoKey> {
    const existing = await this.records.get(KEY_RECORD);
    if (existing instanceof CryptoKey) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    await this.records.put(KEY_RECORD, key);
    return key;
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(new Error("browser storage request failed"));
    };
  });
}

/** IndexedDB-backed RecordStore with one object store. */
export function indexedDbRecords(database = "agent-collab-viewer"): RecordStore {
  const STORE = "records";
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= (() => {
      const req = indexedDB.open(database, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      return request(req);
    })();
    return db;
  };
  const run = async <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>) =>
    request(op((await open()).transaction(STORE, mode).objectStore(STORE)));
  return {
    get: (key) => run("readonly", (store) => store.get(key)),
    put: async (key, value) => {
      await run("readwrite", (store) => store.put(value, key));
    },
    delete: async (key) => {
      await run("readwrite", (store) => store.delete(key));
    },
  };
}

/** Native side of the OS keychain (macOS Keychain, Android Keystore) in packaged builds. */
export interface KeychainBridge {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
}

/** Placeholder until the Tauri packaging slice provides the native bridge. */
export const unavailableKeychain: KeychainBridge = {
  get: () => Promise.reject(new Error("The OS keychain is not available in this build.")),
  set: () => Promise.reject(new Error("The OS keychain is not available in this build.")),
  delete: () => Promise.reject(new Error("The OS keychain is not available in this build.")),
};

export class TauriKeychainStore implements CredentialStore {
  constructor(private readonly bridge: KeychainBridge) {}

  async get(name: SecretName): Promise<Secret | null> {
    const value = await this.bridge.get(name);
    return value === null ? null : new Secret(value);
  }

  set(name: SecretName, secret: Secret): Promise<void> {
    return this.bridge.set(name, secret.reveal());
  }

  delete(name: SecretName): Promise<void> {
    return this.bridge.delete(name);
  }
}

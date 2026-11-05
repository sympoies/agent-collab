import { describe, expect, it } from "vitest";

import type { RecordStore } from "../src/credentials/store";
import { folderMemory } from "../src/source/folder-memory";
import type { LocalDirectoryHandle } from "../src/source/local-folder";

function records(): RecordStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

function handle(
  name: string,
  permission: PermissionState | Error = "granted",
  onRequest: PermissionState = "granted",
): LocalDirectoryHandle {
  return {
    kind: "directory",
    name,
    values: async function* () {
      await Promise.resolve();
      yield* [];
    },
    getDirectoryHandle: () => Promise.reject(new Error("unused")),
    getFileHandle: () => Promise.reject(new Error("unused")),
    queryPermission: () =>
      permission instanceof Error ? Promise.reject(permission) : Promise.resolve(permission),
    requestPermission: () => Promise.resolve(onRequest),
  };
}

const throwing: RecordStore = {
  get: () => Promise.reject(new Error("blocked")),
  put: () => Promise.reject(new Error("blocked")),
  delete: () => Promise.reject(new Error("blocked")),
};

describe("folder memory", () => {
  it("remembers one folder by handle and display name, active until told otherwise", async () => {
    const memory = folderMemory(records());
    expect(await memory.load()).toBeNull();
    await memory.save(handle("clone-a"));
    const found = await memory.load();
    expect(found?.name).toBe("clone-a");
    expect(found?.active).toBe(true);
    expect(found?.open().name).toBe("clone-a");
  });

  it("stores only the handle, the name and the active flag", async () => {
    const store = records();
    await folderMemory(store).save(handle("clone-a"));
    const [value] = [...store.values.values()] as Record<string, unknown>[];
    expect(Object.keys(value ?? {}).sort()).toEqual(["active", "handle", "name"]);
  });

  it("replaces the remembered folder with another and forgets it", async () => {
    const memory = folderMemory(records());
    await memory.save(handle("clone-a"));
    await memory.save(handle("clone-b"));
    expect((await memory.load())?.name).toBe("clone-b");
    await memory.setActive(false);
    expect((await memory.load())?.active).toBe(false);
    await memory.forget();
    expect(await memory.load()).toBeNull();
  });

  it("reports the permission as granted, prompt or denied, and asks for it on request", async () => {
    for (const state of ["granted", "prompt", "denied"] as const) {
      const memory = folderMemory(records());
      await memory.save(handle("clone", state, "granted"));
      const found = await memory.load();
      expect(await found?.permission()).toBe(state);
      expect(await found?.request()).toBe("granted");
    }
    const failing = folderMemory(records());
    await failing.save(handle("clone", new Error("gone")));
    expect(await (await failing.load())?.permission()).toBe("denied");
  });

  it("treats a handle without permission methods as needing a prompt", async () => {
    const memory = folderMemory(records());
    const bare = handle("clone");
    Reflect.deleteProperty(bare, "queryPermission");
    Reflect.deleteProperty(bare, "requestPermission");
    await memory.save(bare);
    const found = await memory.load();
    expect(await found?.permission()).toBe("prompt");
    expect(await found?.request()).toBe("denied");
  });

  it("ignores a damaged record and works from nothing when storage throws", async () => {
    const store = records();
    store.values.set("local-folder", { handle: "x", name: 7 });
    expect(await folderMemory(store).load()).toBeNull();
    const memory = folderMemory(throwing);
    expect(await memory.load()).toBeNull();
    await expect(memory.save(handle("clone"))).resolves.toBeUndefined();
    await expect(memory.setActive(false)).resolves.toBeUndefined();
    await expect(memory.forget()).resolves.toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";

import { CachedDemoSource } from "../src/source/cached-demo";
import { FixtureSource } from "../src/source/fixture";

class MemoryStorage {
  readonly values = new Map<string, string>();
  fail = false;

  getItem(key: string): string | null {
    if (this.fail) throw new Error("storage blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.fail) throw new Error("storage blocked");
    this.values.set(key, value);
  }
}

describe("CachedDemoSource", () => {
  it("reuses immutable public blobs across source instances", async () => {
    const storage = new MemoryStorage();
    const source = new FixtureSource({ ".agent-collab": "collab-protocol: 1\n" });
    const entry = (await source.listDirectory("r1", "")).find(
      (item) => item.name === ".agent-collab",
    );
    if (entry === undefined) throw new Error("fixture marker is missing");
    const read = vi.spyOn(source, "readFile");

    await expect(new CachedDemoSource(source, storage).readFile(entry)).resolves.toContain(
      "collab-protocol",
    );
    await expect(new CachedDemoSource(source, storage).readFile(entry)).resolves.toContain(
      "collab-protocol",
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("keeps loading when guarded browser storage fails", async () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    const source = new FixtureSource({ ".agent-collab": "collab-protocol: 1\n" });
    const entry = (await source.listDirectory("r1", "")).find(
      (item) => item.name === ".agent-collab",
    );
    if (entry === undefined) throw new Error("fixture marker is missing");
    await expect(new CachedDemoSource(source, storage).readFile(entry)).resolves.toContain(
      "collab-protocol",
    );
  });
});

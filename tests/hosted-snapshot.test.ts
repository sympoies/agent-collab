import { describe, expect, it, vi } from "vitest";

import { readHostedSnapshot } from "../src/settings/demo-snapshot";
import { HostedSnapshotSource } from "../src/source/hosted-snapshot";
import { Loader } from "../src/loader/loader";
import { SourceError } from "../src/source/types";
import { flat, MARKER, messageText } from "./support";

const ID = "2026-10-01T0901-alice-agent-api-01";
const snapshot = (revision: string, body: string, generatedAt = "2026-11-04T09:00:00.000Z") =>
  JSON.stringify({
    schemaVersion: 1,
    generatedAt,
    revision,
    files: [
      { path: ".agent-collab", text: MARKER },
      { path: flat("2026-10", 1, 1), text: messageText(ID, "alice-agent", "api", {}, body) },
    ],
  });
const BASE = "https://viewer.example.com/";
const reply = (body: string, status = 200) => Promise.resolve(new Response(body, { status }));

describe("hosted snapshot file", () => {
  it("is fetched from next to the page, uncached and without credentials", async () => {
    const fetcher = vi.fn(() => reply(snapshot("r1", "Hello.")));
    const read = await readHostedSnapshot(fetcher, "https://viewer.example.com/app/");
    expect(read?.revision).toBe("r1");
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://viewer.example.com/app/hosted-snapshot.json");
    expect(init).toMatchObject({ cache: "no-store", credentials: "omit" });
  });

  it("is absent for a missing file, a page served in its place or an invalid snapshot", async () => {
    for (const response of [
      () => reply("", 404),
      () => reply("<!doctype html><title>app</title>"),
      () => reply(JSON.stringify({ schemaVersion: 1 })),
    ]) {
      expect(await readHostedSnapshot(response, "https://viewer.example.com/")).toBeNull();
    }
    expect(await readHostedSnapshot(() => Promise.reject(new Error("offline")), BASE)).toBeNull();
  });
});

describe("HostedSnapshotSource", () => {
  it("shows the snapshot, answers not-modified for the same revision and picks up a new one", async () => {
    let current = snapshot("r1", "First.");
    const source = new HostedSnapshotSource(() => reply(current), BASE);
    const loader = new Loader(source);
    await loader.open();
    const text = () => JSON.stringify(loader.getSnapshot().items);
    expect(text()).toContain("First.");
    expect(source.snapshotTime()?.toISOString()).toBe("2026-11-04T09:00:00.000Z");

    // Same revision, newer generatedAt: nothing is republished.
    current = snapshot("r1", "First.", "2026-11-04T09:01:00.000Z");
    const before = loader.getSnapshot();
    await loader.refresh();
    expect(loader.getSnapshot()).toBe(before);
    expect(source.snapshotTime()?.toISOString()).toBe("2026-11-04T09:01:00.000Z");

    current = snapshot("r2", "Second.", "2026-11-04T09:02:00.000Z");
    await loader.refresh();
    expect(text()).toContain("Second.");
    expect(source.snapshotTime()?.toISOString()).toBe("2026-11-04T09:02:00.000Z");
  });

  it("fails a refresh when the file is gone and recovers when it returns", async () => {
    let current: string | null = snapshot("r1", "First.");
    const source = new HostedSnapshotSource(
      () => (current === null ? reply("", 404) : reply(current)),
      BASE,
    );
    const loader = new Loader(source);
    await loader.open();
    const checked = source.checkedAt();
    expect(checked).not.toBeNull();
    current = null;
    await expect(loader.refresh()).rejects.toBeInstanceOf(SourceError);
    // The data and the time of the last successful check stay.
    expect(JSON.stringify(loader.getSnapshot().items)).toContain("First.");
    expect(source.checkedAt()).toBe(checked);
    expect(source.snapshotTime()?.toISOString()).toBe("2026-11-04T09:00:00.000Z");
    current = snapshot("r2", "Back.");
    await loader.refresh();
    expect(JSON.stringify(loader.getSnapshot().items)).toContain("Back.");
  });
});

import { describe, expect, it } from "vitest";

import { Loader } from "../src/loader/loader";
import { DemoSnapshotSource, type DemoSnapshot } from "../src/settings/demo-snapshot";
import type { DirectoryEntry, Head, MessageSource } from "../src/source/types";
import { messageText } from "./support";

const MARKER = "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent\n";
const id = (topic: string, minute: number) =>
  `2026-11-04T09${String(minute).padStart(2, "0")}-alice-agent-${topic}-01`;
const path = (topic: string, minute: number) =>
  `topics/${topic}/inbox/2026-11/${id(topic, minute)}.md`;
const file = (topic: string, minute: number, body: string) => ({
  path: path(topic, minute),
  text: messageText(id(topic, minute), "alice-agent", topic, {}, body),
});

function snapshot(revision: string, files: DemoSnapshot["files"]): DemoSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-11-04T09:00:00.000Z",
    revision,
    files: [{ path: ".agent-collab", text: MARKER }, ...files],
  };
}

/** Serves whichever snapshot is current, like HostedSnapshotSource after a poll. */
class Switching implements MessageSource {
  current: DemoSnapshotSource;
  constructor(first: DemoSnapshot) {
    this.current = new DemoSnapshotSource(first);
  }
  switchTo(next: DemoSnapshot): void {
    this.current = new DemoSnapshotSource(next);
  }
  head(previous: Head | null) {
    return this.current.head(previous);
  }
  listDirectory(revision: string, directory: string) {
    return this.current.listDirectory(revision, directory);
  }
  readFile(entry: DirectoryEntry) {
    return this.current.readFile(entry);
  }
  rateLimit() {
    return null;
  }
}

const bodies = (loader: Loader) => JSON.stringify(loader.getSnapshot().items);

async function openedOn(first: DemoSnapshot) {
  const source = new Switching(first);
  const loader = new Loader(source);
  await loader.open();
  return { source, loader };
}

describe("a refreshed snapshot of the topic layout", () => {
  const base = [file("general", 1, "First."), file("ops", 1, "Ops first.")];

  it("shows a message added under an existing month folder", async () => {
    const { source, loader } = await openedOn(snapshot("r1", base));
    expect(bodies(loader)).not.toContain("Added.");
    source.switchTo(snapshot("r2", [...base, file("general", 2, "Added.")]));
    await loader.refresh();
    expect(bodies(loader)).toContain("Added.");
  });

  it("shows an edit of an existing message", async () => {
    const { source, loader } = await openedOn(snapshot("r1", base));
    source.switchTo(snapshot("r2", [file("general", 1, "Edited."), base[1] as never]));
    await loader.refresh();
    expect(bodies(loader)).toContain("Edited.");
    expect(bodies(loader)).not.toContain("First.");
  });
});

describe("directory object ids of a snapshot", () => {
  const ids = async (source: DemoSnapshotSource, revision: string, directory: string) =>
    Object.fromEntries(
      (await source.listDirectory(revision, directory)).map((entry) => [
        entry.name,
        entry.objectId,
      ]),
    );
  const base = [file("general", 1, "First."), file("ops", 1, "Ops first.")];

  it("stay the same for the same files", async () => {
    const a = new DemoSnapshotSource(snapshot("r1", base));
    const b = new DemoSnapshotSource(snapshot("r2", [...base].reverse()));
    expect(await ids(a, "r1", "topics")).toEqual(await ids(b, "r2", "topics"));
  });

  it("change when a message is edited or removed", async () => {
    const a = new DemoSnapshotSource(snapshot("r1", base));
    const edited = new DemoSnapshotSource(
      snapshot("r2", [file("general", 1, "Edited."), base[1] as never]),
    );
    const removed = new DemoSnapshotSource(snapshot("r3", [base[1] as never]));
    const before = (await ids(a, "r1", "topics")).general;
    expect((await ids(edited, "r2", "topics")).general).not.toBe(before);
    expect((await ids(removed, "r3", "topics")).general).toBeUndefined();
    expect((await ids(removed, "r3", "")).topics).not.toBe((await ids(a, "r1", "")).topics);
  });

  it("change for the folders above a changed file and not for an unrelated topic", async () => {
    const a = new DemoSnapshotSource(snapshot("r1", base));
    const b = new DemoSnapshotSource(snapshot("r2", [...base, file("general", 2, "Added.")]));
    const before = await ids(a, "r1", "topics");
    const after = await ids(b, "r2", "topics");
    expect(after.general).not.toBe(before.general);
    expect(after.ops).toBe(before.ops);
    const months = (source: DemoSnapshotSource, revision: string) =>
      ids(source, revision, "topics/general/inbox");
    expect((await months(b, "r2"))["2026-11"]).not.toBe((await months(a, "r1"))["2026-11"]);
  });
});

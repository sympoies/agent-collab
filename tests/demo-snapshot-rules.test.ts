import { describe, expect, it, vi } from "vitest";

import {
  MAX_FILE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
  assembleSnapshot,
  decodeText,
  isSnapshotEntry,
  isSnapshotPath,
  type TreeEntry,
} from "../scripts/demo-snapshot-rules.mjs";
import { parseDemoSnapshot } from "../src/settings/demo-snapshot";
import { pngBytes } from "./support";

const blob = (path: string, size?: number): TreeEntry => ({
  path,
  type: "blob",
  mode: "100644",
  sha: `sha:${path}`,
  ...(size === undefined ? {} : { size }),
});
const text = (value: string) => new TextEncoder().encode(value);

describe("what enters the demo snapshot", () => {
  it("keeps the marker, the root index, root inbox messages and everything under topics/", () => {
    for (const path of [
      ".agent-collab",
      "index.md",
      "inbox/2026-11-03T0900-alice-agent-api-01.md",
      "inbox/2026-11/2026-11-03T0900-alice-agent-api-01.md",
      "topics/api/TOPIC.md",
      "topics/api/inbox/2026-11/2026-11-03T0900-alice-agent-api-01.md",
      "topics/api/diagram.png",
    ]) {
      expect(isSnapshotPath(path), path).toBe(true);
    }
    for (const path of [
      "README.md",
      "open.md",
      "inbox/notes.txt",
      "other/index.md",
      "keys/a.pub",
    ]) {
      expect(isSnapshotPath(path), path).toBe(false);
    }
  });

  it("refuses paths the page's snapshot parser would refuse", () => {
    for (const path of [
      "topics/../escape.md",
      "topics/./a.md",
      "topics//a.md",
      "/topics/a.md",
      "inbox/../index.md",
    ]) {
      expect(isSnapshotPath(path), path).toBe(false);
    }
  });

  it("takes regular files only", () => {
    expect(isSnapshotEntry({ ...blob("topics/api/vendor"), type: "commit", mode: "160000" })).toBe(
      false,
    );
    expect(isSnapshotEntry(blob("index.md"))).toBe(true);
    expect(isSnapshotEntry({ ...blob("index.md"), type: "tree" })).toBe(false);
    expect(isSnapshotEntry({ ...blob("index.md"), mode: "120000" })).toBe(false);
    expect(isSnapshotEntry({ path: "index.md", type: "blob", mode: "100644" })).toBe(false);
    expect(isSnapshotEntry(null)).toBe(false);
  });
});

describe("reading a blob", () => {
  it("decodes UTF-8 text, including multi-byte characters", () => {
    expect(decodeText(text("plain\nnaïve 日本語\n"))).toBe("plain\nnaïve 日本語\n");
    expect(decodeText(new Uint8Array())).toBe("");
  });

  it("treats a NUL byte or invalid UTF-8 as binary", () => {
    expect(decodeText(pngBytes(2, 2))).toBeNull();
    expect(decodeText(Uint8Array.of(0x61, 0x00, 0x62))).toBeNull();
    expect(decodeText(Uint8Array.of(0xff, 0xfe, 0x41))).toBeNull();
  });
});

describe("assembling the snapshot", () => {
  const base = {
    revision: "tree",
    generatedAt: "2026-11-04T08:00:00.000Z",
  };

  it("includes the root index, keeps text attachments and lists binary ones without content", async () => {
    const contents: Record<string, Uint8Array> = {
      ".agent-collab": text("collab-protocol: 1\ninbox-layout: topic\n"),
      "index.md": text("| topic | title | status |\n|---|---|---|\n| api | API | open |\n"),
      "topics/api/inbox/2026-11/2026-11-03T0900-alice-agent-api-01.md": text("message"),
      "topics/api/fields.csv": text("a,b\n1,2\n"),
      "topics/api/spec.json": text('{"openapi":"3.0.3"}'),
      "topics/api/diagram.png": pngBytes(3, 3),
      "README.md": text("not included"),
    };
    const readBytes = vi.fn((entry: TreeEntry) =>
      Promise.resolve(contents[entry.path] as Uint8Array),
    );
    const { snapshot, json } = await assembleSnapshot({
      ...base,
      entries: Object.keys(contents).map((path) => blob(path)),
      readBytes,
    });
    expect(snapshot.files.map((file) => file.path)).toEqual([
      ".agent-collab",
      "index.md",
      "topics/api/diagram.png",
      "topics/api/fields.csv",
      "topics/api/inbox/2026-11/2026-11-03T0900-alice-agent-api-01.md",
      "topics/api/spec.json",
    ]);
    const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
    expect(byPath.get("index.md")?.text).toContain("| api | API | open |");
    expect(byPath.get("topics/api/fields.csv")?.text).toBe("a,b\n1,2\n");
    expect(byPath.get("topics/api/spec.json")?.text).toBe('{"openapi":"3.0.3"}');
    expect(byPath.get("topics/api/diagram.png")).toEqual({
      path: "topics/api/diagram.png",
      text: "",
      omitted: true,
      size: pngBytes(3, 3).length,
    });
    expect(readBytes).not.toHaveBeenCalledWith(expect.objectContaining({ path: "README.md" }));
    // The page accepts exactly what the script writes.
    expect(parseDemoSnapshot(json)).toEqual(snapshot);
  });

  it("keeps a topic's own index.md next to the root index.md", async () => {
    const { snapshot } = await assembleSnapshot({
      ...base,
      entries: [blob(".agent-collab"), blob("index.md"), blob("topics/api/index.md")],
      readBytes: (entry) => Promise.resolve(text(`content of ${entry.path}\n`)),
    });
    const byPath = new Map(snapshot.files.map((file) => [file.path, file.text]));
    expect(byPath.get("index.md")).toBe("content of index.md\n");
    expect(byPath.get("topics/api/index.md")).toBe("content of topics/api/index.md\n");
  });

  it("lists a binary TOPIC.md without content, like any other attachment", async () => {
    const { snapshot } = await assembleSnapshot({
      ...base,
      entries: [blob(".agent-collab"), blob("topics/api/TOPIC.md")],
      readBytes: (entry) =>
        Promise.resolve(
          entry.path === ".agent-collab" ? text("collab-protocol: 1\n") : pngBytes(2, 2),
        ),
    });
    expect(snapshot.files[1]).toMatchObject({
      path: "topics/api/TOPIC.md",
      text: "",
      omitted: true,
    });
  });

  it("lists an oversized attachment without reading it, and drops an oversized or binary message", async () => {
    const readBytes = vi.fn((entry: TreeEntry) =>
      Promise.resolve(
        entry.path === ".agent-collab" ? text("collab-protocol: 1\n") : Uint8Array.of(0, 1, 2),
      ),
    );
    const { snapshot } = await assembleSnapshot({
      ...base,
      entries: [
        blob(".agent-collab"),
        blob("topics/api/big.csv", MAX_FILE_BYTES + 1),
        blob("topics/api/inbox/2026-11/2026-11-03T0900-alice-agent-api-01.md", MAX_FILE_BYTES + 1),
        blob("inbox/2026-11-03T0900-alice-agent-api-02.md"),
      ],
      readBytes,
    });
    expect(snapshot.files.map((file) => file.path)).toEqual([
      ".agent-collab",
      "topics/api/big.csv",
    ]);
    expect(snapshot.files[1]).toEqual({
      path: "topics/api/big.csv",
      text: "",
      omitted: true,
      size: MAX_FILE_BYTES + 1,
    });
    expect(readBytes).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "topics/api/big.csv" }),
    );
  });

  it("measures the size of a file whose size the tree did not list", async () => {
    const { snapshot } = await assembleSnapshot({
      ...base,
      entries: [blob(".agent-collab"), blob("topics/api/unknown-size.bin")],
      readBytes: (entry) =>
        Promise.resolve(
          entry.path === ".agent-collab" ? text("collab-protocol: 1\n") : pngBytes(2, 2),
        ),
    });
    expect(snapshot.files[1]).toMatchObject({ omitted: true, size: pngBytes(2, 2).length });
  });

  it("fails clearly without a marker", async () => {
    await expect(
      assembleSnapshot({
        ...base,
        entries: [blob("index.md")],
        readBytes: () => Promise.resolve(text("x")),
      }),
    ).rejects.toThrow("marker is missing");
  });

  it("fails clearly when the snapshot is over the size limit", async () => {
    const chunk = "x".repeat(MAX_FILE_BYTES - 1024);
    const entries = [blob(".agent-collab")];
    for (let n = 0; n < Math.ceil(MAX_SNAPSHOT_BYTES / chunk.length) + 1; n += 1) {
      entries.push(blob(`topics/api/notes-${String(n)}.md`));
    }
    await expect(
      assembleSnapshot({
        ...base,
        entries,
        readBytes: (entry) =>
          Promise.resolve(text(entry.path === ".agent-collab" ? "collab-protocol: 1\n" : chunk)),
      }),
    ).rejects.toThrow(`the limit is ${String(MAX_SNAPSHOT_BYTES)}`);
  });

  it("fails clearly when the repository has too many files", async () => {
    const entries = [blob(".agent-collab")];
    for (let n = 0; n < MAX_SNAPSHOT_FILES; n += 1)
      entries.push(blob(`topics/api/f-${String(n)}.md`));
    await expect(
      assembleSnapshot({ ...base, entries, readBytes: () => Promise.resolve(text("x")) }),
    ).rejects.toThrow(`the limit is ${String(MAX_SNAPSHOT_FILES)}`);
  });
});

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES } from "../scripts/demo-snapshot-rules.mjs";
import { buildFolderSnapshot, writeFileAtomic } from "../scripts/folder-snapshot.mjs";
import { parseDemoSnapshot } from "../src/settings/demo-snapshot";
import { flat, MARKER, messageText, monthly, pngBytes } from "./support";

const NOW = "2026-11-04T09:00:00.000Z";
const ID = "2026-10-01T0901-alice-agent-api-01";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function clone(files: Record<string, string | Uint8Array>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "folder-snapshot-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

const message = (id = ID) => messageText(id, "alice-agent", "api", {}, "From the clone.");
const paths = (files: readonly { path: string }[]) => files.map((file) => file.path).sort();

describe("folder snapshot builder", () => {
  it("builds what the page parses from a flat, a monthly and a topic layout", async () => {
    const dir = await clone({
      ".agent-collab": MARKER,
      "index.md": "# Topics\n",
      "README.md": "not part of the snapshot\n",
      [flat("2026-10", 1, 1)]: message(),
      [monthly("2026-10", 2, 2)]: message("2026-10-02T0902-alice-agent-api-01"),
      "topics/api/TOPIC.md": "---\ntitle: API\n---\n",
      "topics/api/inbox/2026-10/2026-10-03T0903-alice-agent-api-01.md": message(
        "2026-10-03T0903-alice-agent-api-01",
      ),
      "topics/api/diagram.png": pngBytes(4, 4),
    });
    const { snapshot, json } = await buildFolderSnapshot(dir, NOW);
    expect(paths(snapshot.files)).toEqual(
      [
        ".agent-collab",
        flat("2026-10", 1, 1),
        "index.md",
        monthly("2026-10", 2, 2),
        "topics/api/TOPIC.md",
        "topics/api/diagram.png",
        "topics/api/inbox/2026-10/2026-10-03T0903-alice-agent-api-01.md",
      ].sort(),
    );
    expect(snapshot.generatedAt).toBe(NOW);
    expect(parseDemoSnapshot(json)?.files).toHaveLength(7);
  });

  it("skips .git and node_modules by name and leaves symbolic links out", async () => {
    const dir = await clone({
      ".agent-collab": MARKER,
      [flat("2026-10", 1, 1)]: message(),
      ".git/inbox/x.md": "git internals",
      "topics/api/node_modules/pkg/inbox/x.md": "dependency",
      "topics/api/.git/config": "nested git",
      "outside.md": "outside the clone",
    });
    await symlink(join(dir, "outside.md"), join(dir, "inbox", "link.md"));
    await symlink(dir, join(dir, "topics", "loop"));
    const { snapshot } = await buildFolderSnapshot(dir, NOW);
    expect(paths(snapshot.files)).toEqual([".agent-collab", flat("2026-10", 1, 1)].sort());
  });

  it("lists an oversized attachment as omitted and still reads small ones", async () => {
    const dir = await clone({
      ".agent-collab": MARKER,
      "topics/api/big.csv": "x".repeat(MAX_FILE_BYTES + 1),
      "topics/api/small.csv": "a,b\n",
    });
    const { snapshot } = await buildFolderSnapshot(dir, NOW);
    expect(snapshot.files.find((file) => file.path === "topics/api/big.csv")).toEqual({
      path: "topics/api/big.csv",
      text: "",
      omitted: true,
      size: MAX_FILE_BYTES + 1,
    });
    expect(snapshot.files.find((file) => file.path === "topics/api/small.csv")?.text).toBe("a,b\n");
  });

  it("fails clearly without the collaboration marker", async () => {
    const dir = await clone({ [flat("2026-10", 1, 1)]: message() });
    await expect(buildFolderSnapshot(dir, NOW)).rejects.toThrow(/marker/);
  });

  it("changes the revision only when the content changes", async () => {
    const files = { ".agent-collab": MARKER, [flat("2026-10", 1, 1)]: message() };
    const dir = await clone(files);
    const first = await buildFolderSnapshot(dir, NOW);
    const again = await buildFolderSnapshot(dir, "2026-11-04T09:01:00.000Z");
    expect(again.snapshot.revision).toBe(first.snapshot.revision);
    expect(again.snapshot.generatedAt).not.toBe(first.snapshot.generatedAt);
    await writeFile(join(dir, flat("2026-10", 1, 1)), message().replace("From", "Edited from"));
    const changed = await buildFolderSnapshot(dir, NOW);
    expect(changed.snapshot.revision).not.toBe(first.snapshot.revision);
  });
});

describe("folder snapshot safety and limits", () => {
  const OUTSIDE = "SECRET outside the clone";

  it("never reads through a file that became a symbolic link after the scan", async () => {
    const dir = await clone({ ".agent-collab": MARKER, [flat("2026-10", 1, 1)]: message() });
    const outside = await clone({ "secret.md": OUTSIDE });
    const target = flat("2026-10", 1, 1);
    await expect(
      buildFolderSnapshot(dir, NOW, {
        beforeRead: async (path) => {
          if (path !== target) return;
          await rm(join(dir, path));
          await symlink(join(outside, "secret.md"), join(dir, path));
        },
      }),
    ).rejects.toThrow();
  });

  it("never reads under a directory that became a symbolic link after the scan", async () => {
    const dir = await clone({ ".agent-collab": MARKER, "topics/api/notes.md": "inside" });
    const outside = await clone({ "notes.md": OUTSIDE });
    let json = "";
    await buildFolderSnapshot(dir, NOW, {
      beforeRead: async (path) => {
        if (path !== "topics/api/notes.md") return;
        await rename(join(dir, "topics", "api"), join(dir, "topics", "moved"));
        await symlink(outside, join(dir, "topics", "api"));
      },
    })
      .then((built) => {
        json = built.json;
      })
      .catch(() => undefined);
    expect(json).not.toContain(OUTSIDE);
  });

  it("builds a clone over the demo's 4 MiB limit", async () => {
    const files: Record<string, string> = { ".agent-collab": MARKER };
    const chunk = "x".repeat(MAX_FILE_BYTES - 1024);
    for (let n = 0; n < Math.ceil(MAX_SNAPSHOT_BYTES / chunk.length) + 1; n += 1) {
      files[`topics/api/notes-${String(n)}.md`] = chunk;
    }
    const { json } = await buildFolderSnapshot(await clone(files), NOW);
    expect(json.length).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
    expect(parseDemoSnapshot(json)).not.toBeNull();
  });

  it("fails without naming the demo", async () => {
    const dir = await clone({ [flat("2026-10", 1, 1)]: message() });
    await expect(buildFolderSnapshot(dir, NOW)).rejects.not.toThrow(/demo/);
  });

  it("leaves out names the local-folder source would refuse", async () => {
    const dir = await clone({
      ".agent-collab": MARKER,
      "topics/api/ok.md": "fine",
      "topics/api/a\\b.md": "backslash",
      "topics/api/ctl\u0001.md": "control character",
    });
    const { snapshot } = await buildFolderSnapshot(dir, NOW);
    expect(paths(snapshot.files)).toEqual([".agent-collab", "topics/api/ok.md"].sort());
  });
});

describe("atomic write", () => {
  it("replaces the file in one rename and leaves no temporary file", async () => {
    const dir = await clone({ "out/hosted-snapshot.json": "old" });
    const target = join(dir, "out", "hosted-snapshot.json");
    await writeFileAtomic(target, "new");
    expect(await readFile(target, "utf8")).toBe("new");
    expect(await readdir(join(dir, "out"))).toEqual(["hosted-snapshot.json"]);
  });

  it("keeps the previous file when the snapshot cannot be built", async () => {
    const source = await clone({ [flat("2026-10", 1, 1)]: message() });
    const out = await clone({ "hosted-snapshot.json": "previous" });
    const target = join(out, "hosted-snapshot.json");
    await expect(
      buildFolderSnapshot(source, NOW).then(({ json }) => writeFileAtomic(target, json)),
    ).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("previous");
  });
});

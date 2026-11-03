import { describe, expect, it } from "vitest";
import { Loader } from "../src/loader/loader";
import {
  LocalFolderSource,
  type LocalDirectoryHandle,
  type LocalFileHandle,
  type LocalHandle,
} from "../src/source/local-folder";
import { SourceError } from "../src/source/types";
import { MARKER, messageText, monthly } from "./support";

type Entry = LocalHandle;

class MemoryFile implements LocalFileHandle {
  readonly kind = "file" as const;
  private version = 1;
  /** Calls to getFile (metadata) and to text() (content), to measure scan cost. */
  metadataReads = 0;
  textReads = 0;
  constructor(
    readonly name: string,
    private content: string,
    private modified: number | null = null,
  ) {}

  replace(content: string, modified: number | null = null): void {
    this.content = content;
    this.version += 1;
    if (modified !== null) this.modified = modified;
  }

  getFile(): Promise<Blob & { readonly lastModified: number }> {
    this.metadataReads += 1;
    const content = this.content;
    const blob = new Blob([content]) as Blob & { lastModified: number };
    Object.defineProperty(blob, "lastModified", { value: this.modified ?? this.version });
    Object.defineProperty(blob, "text", {
      value: () => {
        this.textReads += 1;
        return Promise.resolve(content);
      },
    });
    return Promise.resolve(blob);
  }
}

class MemoryDirectory implements LocalDirectoryHandle {
  readonly kind = "directory" as const;
  readonly children = new Map<string, Entry>();
  permission: PermissionState = "granted";
  /** How often the directory was enumerated. */
  enumerations = 0;

  constructor(readonly name = "") {}

  async *values(): AsyncIterable<Entry> {
    this.enumerations += 1;
    await Promise.resolve();
    yield* this.children.values();
  }

  getDirectoryHandle(name: string): Promise<LocalDirectoryHandle> {
    const entry = this.children.get(name);
    if (!(entry instanceof MemoryDirectory)) {
      return Promise.reject(new DOMException("Missing directory", "NotFoundError"));
    }
    return Promise.resolve(entry);
  }

  getFileHandle(name: string): Promise<LocalFileHandle> {
    const entry = this.children.get(name);
    if (!(entry instanceof MemoryFile)) {
      return Promise.reject(new DOMException("Missing file", "NotFoundError"));
    }
    return Promise.resolve(entry);
  }

  queryPermission(): Promise<PermissionState> {
    return Promise.resolve(this.permission);
  }

  addFile(path: string, content: string, modified: number | null = null): MemoryFile {
    const segments = path.split("/");
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error("Invalid fixture path");
    const directory = segments.reduce<MemoryDirectory>((current, segment) => {
      let child = current.children.get(segment);
      if (child === undefined) {
        child = new MemoryDirectory(segment);
        current.children.set(segment, child);
      }
      if (!(child instanceof MemoryDirectory)) throw new Error("Fixture path conflict");
      return child;
    }, this);
    const file = new MemoryFile(fileName, content, modified);
    directory.children.set(fileName, file);
    return file;
  }
}

describe("LocalFolderSource", () => {
  it("walks the nested inbox layout and feeds message text to the existing loader parser", async () => {
    const root = new MemoryDirectory();
    const path = monthly("2026-10", 1, 1);
    root.addFile(".agent-collab", MARKER);
    root.addFile(path, messageText("2026-10-01T0901-alice-agent-api-01", "alice-agent", "api"));

    const loader = new Loader(new LocalFolderSource(root));
    await loader.open();

    expect(loader.getSnapshot().items).toMatchObject([
      { kind: "message", message: { path, body: { state: "plain" } } },
    ]);
  });

  it("keeps opening when one message fails during metadata inspection", async () => {
    class DeniedFile extends MemoryFile {
      override getFile(): Promise<Blob & { readonly lastModified: number }> {
        return Promise.reject(new DOMException("private detail", "NotAllowedError"));
      }
    }

    const root = new MemoryDirectory();
    root.addFile(".agent-collab", MARKER);
    root.addFile(
      monthly("2026-10", 1, 1),
      messageText("2026-10-01T0901-alice-agent-api-01", "alice-agent", "api"),
    );
    const inbox = root.children.get("inbox");
    const month = inbox instanceof MemoryDirectory ? inbox.children.get("2026-10") : undefined;
    if (!(month instanceof MemoryDirectory)) throw new Error("Expected a month directory");
    const deniedName = "2026-10-02T0901-alice-agent-api-01.md";
    month.children.set(deniedName, new DeniedFile(deniedName, "unavailable message"));

    const loader = new Loader(new LocalFolderSource(root));
    await expect(loader.open()).resolves.toBeUndefined();

    expect(loader.getSnapshot().items).toContainEqual(
      expect.objectContaining({
        kind: "unavailable",
        path: `inbox/2026-10/${deniedName}`,
        error: "unexpected",
      }),
    );
    expect(loader.getSnapshot().items.some((item) => item.kind === "message")).toBe(true);
  });

  it("refreshes a new message in an existing month", async () => {
    const root = new MemoryDirectory();
    root.addFile(".agent-collab", MARKER);
    root.addFile(
      monthly("2026-10", 1, 1),
      messageText("2026-10-01T0901-alice-agent-api-01", "alice-agent", "api"),
    );
    const loader = new Loader(new LocalFolderSource(root));
    await loader.open();
    const addedPath = monthly("2026-10", 2, 1);
    root.addFile(
      addedPath,
      messageText("2026-10-02T0901-alice-agent-api-01", "alice-agent", "api"),
    );

    await expect(loader.refresh()).resolves.toBe(1);
    expect(
      loader.getSnapshot().items.map((item) => item.kind === "message" && item.message.path),
    ).toContain(addedPath);
  });

  it("refreshes a newly added month", async () => {
    const root = new MemoryDirectory();
    root.addFile(".agent-collab", MARKER);
    root.addFile(
      monthly("2026-10", 1, 1),
      messageText("2026-10-01T0901-alice-agent-api-01", "alice-agent", "api"),
    );
    const loader = new Loader(new LocalFolderSource(root));
    await loader.open();
    const addedPath = monthly("2026-11", 1, 1);
    root.addFile(
      addedPath,
      messageText("2026-11-01T0901-alice-agent-api-01", "alice-agent", "api"),
    );

    await expect(loader.refresh()).resolves.toBe(1);
    expect(
      loader.getSnapshot().items.map((item) => item.kind === "message" && item.message.path),
    ).toContain(addedPath);
  });

  it("refreshes the participant roster after the marker changes", async () => {
    const root = new MemoryDirectory();
    const marker = root.addFile(".agent-collab", `${MARKER}participants: alice-agent\n`);
    const loader = new Loader(new LocalFolderSource(root));
    await loader.open();
    expect(loader.getSnapshot().participants).toEqual(["alice-agent"]);
    marker.replace(`${MARKER}participants: alice-agent,bob-agent\n`);

    await expect(loader.refresh()).resolves.toBe(0);
    expect(loader.getSnapshot().participants).toEqual(["alice-agent", "bob-agent"]);
  });

  it("does not republish a snapshot on an unchanged poll", async () => {
    const root = new MemoryDirectory();
    root.addFile(".agent-collab", MARKER);
    root.addFile(
      monthly("2026-10", 1, 1),
      messageText("2026-10-01T0901-alice-agent-api-01", "alice-agent", "api"),
    );
    const loader = new Loader(new LocalFolderSource(root));
    await loader.open();
    let publications = 0;
    loader.subscribe(() => {
      publications += 1;
    });

    await expect(loader.refresh()).resolves.toBe(0);

    expect(publications).toBe(0);
    expect(loader.getSnapshot().items).toHaveLength(1);
  });

  it("keeps the revision bounded and stable across repeated polls of an unchanged folder", async () => {
    const source = new LocalFolderSource(new MemoryDirectory());
    const first = await source.head(null);
    if (first === "not-modified") throw new Error("expected a head");
    for (let index = 0; index < 1000; index += 1) {
      expect(await source.head(first)).toBe("not-modified");
    }
    expect(first.revision.length).toBeLessThan(32);
  });

  it("keeps entry identities stable when unchanged and updates them when metadata changes", async () => {
    const root = new MemoryDirectory();
    const marker = root.addFile(".agent-collab", MARKER);
    const message = root.addFile("inbox/2026-10/message.md", "first version");
    const source = new LocalFolderSource(root);
    const firstRoot = await source.listDirectory("local-1", "");
    const repeatedRoot = await source.listDirectory("local-2", "");
    const firstMonth = await source.listDirectory("local-1", "inbox");
    const repeatedMonth = await source.listDirectory("local-2", "inbox");

    expect(firstRoot.map(({ objectId }) => objectId)).toEqual(
      repeatedRoot.map(({ objectId }) => objectId),
    );
    expect(firstMonth[0]?.objectId).toBe(repeatedMonth[0]?.objectId);

    message.replace("second version is longer");
    const changedMonth = await source.listDirectory("local-3", "inbox");
    expect(changedMonth[0]?.objectId).not.toBe(firstMonth[0]?.objectId);

    marker.replace(`${MARKER}participants: alice-agent,bob-agent\n`);
    const changedRoot = await source.listDirectory("local-4", "");
    expect(changedRoot.find(({ name }) => name === ".agent-collab")?.objectId).not.toBe(
      firstRoot.find(({ name }) => name === ".agent-collab")?.objectId,
    );
  });

  it("bounds metadata concurrency across nested directories", async () => {
    let active = 0;
    let maximumActive = 0;
    class DelayedFile extends MemoryFile {
      override async getFile(): Promise<Blob & { readonly lastModified: number }> {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return super.getFile();
      }
    }

    const root = new MemoryDirectory();
    const topics = new MemoryDirectory("topics");
    root.children.set("topics", topics);
    for (let directoryIndex = 0; directoryIndex < 8; directoryIndex += 1) {
      const directory = new MemoryDirectory(`design-${directoryIndex}`);
      topics.children.set(directory.name, directory);
      for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
        const name = `file-${fileIndex}.md`;
        directory.children.set(name, new DelayedFile(name, "content"));
      }
    }

    const entries = await new LocalFolderSource(root).listDirectory("local-1", "topics");

    expect(entries).toHaveLength(8);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(6);
  });

  it("skips hostile names and symlink-like entries while listing a directory", async () => {
    const root = new MemoryDirectory();
    root.addFile(".agent-collab", MARKER);
    root.addFile("inbox/2026-10/valid.md", "valid message");
    const topics = new MemoryDirectory("topics");
    root.children.set("topics", topics);
    const inbox = root.children.get("inbox");
    const month = inbox instanceof MemoryDirectory ? inbox.children.get("2026-10") : undefined;
    if (!(month instanceof MemoryDirectory)) throw new Error("Expected a month directory");
    for (const name of [
      "../outside.md",
      ".",
      "..",
      "back\\slash.md",
      "bad\u0001name.md",
      "",
      "nested/file.md",
    ]) {
      month.children.set(name, new MemoryFile(name, "hostile"));
    }
    topics.children.set("link", { kind: "symlink", name: "link" });

    const source = new LocalFolderSource(root);
    const entries = await source.listDirectory("local-1", "inbox/2026-10");
    const topicEntries = await source.listDirectory("local-1", "topics");

    expect(entries.map(({ name }) => name)).toEqual(["valid.md"]);
    expect(topicEntries).toEqual([]);
  });

  it("preserves ordinary Unicode and spaced names under topics", async () => {
    const root = new MemoryDirectory();
    root.addFile("topics/design notes/fields café.md", "topic text");
    const source = new LocalFolderSource(root);
    const [directory] = await source.listDirectory("local-1", "topics");
    const path = "topics/design notes";
    const [file] = await source.listDirectory("local-1", path);

    expect(directory?.name).toBe("design notes");
    expect(file?.path).toBe("topics/design notes/fields café.md");
    if (file === undefined) throw new Error("Expected a listed topic file");
    expect(await source.readFile(file)).toBe("topic text");
  });

  it("rejects traversal paths before touching the handle", async () => {
    const source = new LocalFolderSource(new MemoryDirectory());
    await expect(
      source.readFile({
        name: "secret.md",
        path: "inbox/../secret.md",
        kind: "file",
        objectId: "x",
      }),
    ).rejects.toMatchObject<Partial<SourceError>>({ kind: "forbidden" });
  });

  it("caps file reads before materializing oversized text", async () => {
    const root = new MemoryDirectory();
    root.addFile("topics/large.md", "x".repeat(1024 * 1024 + 1));
    const source = new LocalFolderSource(root);
    const [entry] = await source.listDirectory("local-1", "topics");

    if (entry === undefined) throw new Error("Expected a listed file");
    await expect(source.readFile(entry)).rejects.toMatchObject({ kind: "too-large" });
  });

  it("accepts a file exactly at the 1 MiB limit", async () => {
    const root = new MemoryDirectory();
    root.addFile("topics/limit.md", "x".repeat(1024 * 1024));
    const source = new LocalFolderSource(root);
    const [entry] = await source.listDirectory("local-1", "topics");

    if (entry === undefined) throw new Error("Expected a listed file");
    await expect(source.readFile(entry)).resolves.toHaveLength(1024 * 1024);
  });

  it("maps a file that disappears after listing to not-found", async () => {
    const root = new MemoryDirectory();
    root.addFile("inbox/2026-10/message.md", "message");
    const source = new LocalFolderSource(root);
    const [entry] = await source.listDirectory("local-1", "inbox/2026-10");
    const inbox = root.children.get("inbox");
    const month = inbox instanceof MemoryDirectory ? inbox.children.get("2026-10") : undefined;
    if (!(month instanceof MemoryDirectory)) throw new Error("Expected a month directory");
    const removed = month.children.delete("message.md");
    expect(removed).toBe(true);

    if (entry === undefined) throw new Error("Expected a listed file");
    await expect(source.readFile(entry)).rejects.toMatchObject({ kind: "not-found" });
  });

  it("reports revoked and unavailable permissions as forbidden", async () => {
    const root = new MemoryDirectory();
    root.permission = "prompt";

    await expect(new LocalFolderSource(root).head(null)).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("maps a read permission exception without exposing the browser exception", async () => {
    const root = new MemoryDirectory();
    root.permission = "granted";
    const denied = new DOMException("private browser detail", "NotAllowedError");
    root.queryPermission = () => Promise.reject(denied);

    await expect(new LocalFolderSource(root).head(null)).rejects.toMatchObject({
      kind: "forbidden",
      message: "Local folder permission is unavailable.",
    });
  });

  describe("freshness polling", () => {
    function clone(messages = 3) {
      const root = new MemoryDirectory();
      root.addFile(".agent-collab", MARKER, 1_000);
      const files: MemoryFile[] = [];
      for (let index = 1; index <= messages; index += 1) {
        const path = monthly("2026-10", 1, index);
        const id = path.slice(path.lastIndexOf("/") + 1, -".md".length);
        files.push(root.addFile(path, messageText(id, "alice-agent", "api"), 2_000 + index));
      }
      return { root, files };
    }

    it("answers not-modified for an unchanged folder, after one metadata read per file and no content reads", async () => {
      const { root, files } = clone();
      const source = new LocalFolderSource(root);
      const first = await source.head(null);
      expect(first).not.toBe("not-modified");
      const reads = files.map((file) => file.metadataReads);
      const head = first === "not-modified" ? null : first;
      expect(await source.head(head)).toBe("not-modified");
      expect(files.map((file) => file.metadataReads)).toEqual(reads.map((count) => count + 1));
      expect(files.every((file) => file.textReads === 0)).toBe(true);
    });

    it("notices a new message, an edit in place, a new month and a changed marker", async () => {
      const { root, files } = clone(1);
      const source = new LocalFolderSource(root);
      let head = await source.head(null);
      const next = async () => {
        const result = await source.head(head === "not-modified" ? null : head);
        expect(result).not.toBe("not-modified");
        head = result;
      };
      root.addFile(monthly("2026-10", 1, 2), "new message", 3_000);
      await next();
      files[0]?.replace("edited in place, so it is longer", 4_000);
      await next();
      root.addFile(monthly("2026-11", 1, 1), "another month", 5_000);
      await next();
      const marker = root.children.get(".agent-collab");
      if (marker instanceof MemoryFile)
        marker.replace(`${MARKER}participants: alice-agent\n`, 6_000);
      await next();
    });

    it("lists from the scan of the same revision without touching files again", async () => {
      const { root, files } = clone(3);
      const source = new LocalFolderSource(root);
      const head = await source.head(null);
      if (head === "not-modified") throw new Error("expected a head");
      const reads = files.map((file) => file.metadataReads);
      const inbox = await source.listDirectory(head.revision, "inbox");
      const month = await source.listDirectory(head.revision, "inbox/2026-10");
      expect(inbox.map((entry) => entry.name)).toEqual(["2026-10"]);
      expect(month).toHaveLength(3);
      expect(files.map((file) => file.metadataReads)).toEqual(reads);
    });

    it("gives file entries their size", async () => {
      const { root } = clone(1);
      const source = new LocalFolderSource(root);
      const head = await source.head(null);
      if (head === "not-modified") throw new Error("expected a head");
      const month = await source.listDirectory(head.revision, "inbox/2026-10");
      expect(month[0]?.size).toBeGreaterThan(0);
      root.addFile("topics/api/notes.md", "twelve chars");
      const topics = await source.listDirectory(head.revision, "topics/api");
      expect(topics[0]).toMatchObject({ name: "notes.md", size: 12 });
    });

    it("reports the newest file modification time seen, and keeps it when a scan fails", async () => {
      const { root, files } = clone(2);
      const source = new LocalFolderSource(root);
      expect(source.lastChanged()).toBeNull();
      await source.head(null);
      expect(source.lastChanged()).toEqual(new Date(2_002));
      files[0]?.replace("touched later", 9_000);
      await source.head(null);
      expect(source.lastChanged()).toEqual(new Date(9_000));
      root.permission = "prompt";
      await expect(source.head(null)).rejects.toMatchObject({ kind: "forbidden" });
      expect(source.lastChanged()).toEqual(new Date(9_000));
    });

    it("makes the loader publish only when something changed, and show an edit in place", async () => {
      const { root, files } = clone(2);
      const loader = new Loader(new LocalFolderSource(root));
      await loader.open();
      let publications = 0;
      loader.subscribe(() => {
        publications += 1;
      });
      await loader.refresh();
      await loader.refresh();
      expect(publications).toBe(0);
      expect(loader.getSnapshot().lastChanged).toEqual(new Date(2_002));

      const path = monthly("2026-10", 1, 1);
      const id = path.slice(path.lastIndexOf("/") + 1, -".md".length);
      files[0]?.replace(messageText(id, "alice-agent", "api", {}, "Edited on disk."), 8_000);
      await expect(loader.refresh()).resolves.toBe(0);
      expect(publications).toBe(1);
      expect(loader.getSnapshot().items[0]).toMatchObject({
        message: { body: { lines: ["Edited on disk."] } },
      });
      expect(loader.getSnapshot().fresh.size).toBe(0);
      expect(loader.getSnapshot().lastChanged).toEqual(new Date(8_000));
    });

    it("measures an unchanged poll of a large clone: one metadata read per file, one listing per directory", async () => {
      const root = new MemoryDirectory();
      const marker = root.addFile(".agent-collab", MARKER, 1);
      const files: MemoryFile[] = [];
      const months = 24;
      const perMonth = 125;
      for (let month = 1; month <= months; month += 1) {
        const name = `${month <= 12 ? "2025" : "2026"}-${String(((month - 1) % 12) + 1).padStart(2, "0")}`;
        for (let index = 1; index <= perMonth; index += 1) {
          const path = `inbox/${name}/${name}-01T${String(Math.floor(index / 60)).padStart(2, "0")}${String(index % 60).padStart(2, "0")}-alice-agent-api-01.md`;
          files.push(root.addFile(path, `message ${String(index)}`, index));
        }
      }
      const source = new LocalFolderSource(root);
      const first = await source.head(null);
      if (first === "not-modified") throw new Error("expected a head");
      const inbox = root.children.get("inbox");
      const directories = [
        root,
        inbox,
        ...(inbox instanceof MemoryDirectory ? inbox.children.values() : []),
      ].filter((entry): entry is MemoryDirectory => entry instanceof MemoryDirectory);
      const before = {
        files: files.reduce((sum, file) => sum + file.metadataReads, 0) + marker.metadataReads,
        listings: directories.reduce((sum, directory) => sum + directory.enumerations, 0),
      };
      expect(before.files).toBe(months * perMonth + 1);
      expect(before.listings).toBe(months + 2);

      expect(await source.head(first)).toBe("not-modified");
      const after = {
        files: files.reduce((sum, file) => sum + file.metadataReads, 0) + marker.metadataReads,
        listings: directories.reduce((sum, directory) => sum + directory.enumerations, 0),
      };
      // The second poll costs exactly the same as the first, and reads no message content.
      expect(after.files - before.files).toBe(months * perMonth + 1);
      expect(after.listings - before.listings).toBe(months + 2);
      expect(files.every((file) => file.textReads === 0)).toBe(true);
    });

    it("uses long identities so two different files do not collide by accident", async () => {
      const { root } = clone(1);
      const source = new LocalFolderSource(root);
      const head = await source.head(null);
      if (head === "not-modified") throw new Error("expected a head");
      const month = await source.listDirectory(head.revision, "inbox/2026-10");
      expect(month[0]?.objectId).toMatch(/^file-[0-9a-f]{14}$/);
    });
  });
});

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
  constructor(
    readonly name: string,
    private content: string,
  ) {}

  replace(content: string): void {
    this.content = content;
    this.version += 1;
  }

  getFile(): Promise<Blob & { readonly lastModified: number }> {
    const blob = new Blob([this.content]) as Blob & { lastModified: number };
    Object.defineProperty(blob, "lastModified", { value: this.version });
    return Promise.resolve(blob);
  }
}

class MemoryDirectory implements LocalDirectoryHandle {
  readonly kind = "directory" as const;
  readonly children = new Map<string, Entry>();
  permission: PermissionState = "granted";

  constructor(readonly name = "") {}

  async *values(): AsyncIterable<Entry> {
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

  addFile(path: string, content: string): MemoryFile {
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
    const file = new MemoryFile(fileName, content);
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

  it("does not add messages on an unchanged poll even though the current loader republishes", async () => {
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

    expect(publications).toBe(1);
    expect(loader.getSnapshot().items).toHaveLength(1);
  });

  it("keeps poll revisions bounded across repeated refreshes", async () => {
    const source = new LocalFolderSource(new MemoryDirectory());
    let previous = await source.head(null);
    for (let index = 0; index < 1000; index += 1) previous = await source.head(previous);

    expect(previous.revision.length).toBeLessThan(32);
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
});

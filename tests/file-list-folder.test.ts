import { describe, expect, it } from "vitest";

import { Loader } from "../src/loader/loader";
import { FileListFolderSource } from "../src/source/file-list-folder";
import { SourceError } from "../src/source/types";
import { messageText } from "./support";

function folderFile(path: string, content: string, reads = { count: 0 }, root = "clone"): File {
  const file = new File([content], path.split("/").at(-1) ?? "", {
    lastModified: 1_800_000_000_000,
  });
  Object.defineProperty(file, "webkitRelativePath", {
    value: root === "" ? path : `${root}/${path}`,
  });
  Object.defineProperty(file, "text", {
    value: () => {
      reads.count += 1;
      return Promise.resolve(content);
    },
  });
  return file;
}

describe("FileListFolderSource", () => {
  it.each([
    [
      "flat",
      "collab-protocol: 1\ninbox-layout: flat\n",
      "inbox/2026-10-01T0901-alice-agent-api-01.md",
    ],
    [
      "monthly",
      "collab-protocol: 1\ninbox-layout: monthly\n",
      "inbox/2026-10/2026-10-01T0901-alice-agent-api-01.md",
    ],
    [
      "topic",
      "collab-protocol: 1\ninbox-layout: topic\n",
      "topics/api/inbox/2026-10/2026-10-01T0901-alice-agent-api-01.md",
    ],
  ])("opens the %s layout through the existing loader", async (_layout, marker, messagePath) => {
    const text = messageText(
      "2026-10-01T0901-alice-agent-api-01",
      "alice-agent",
      "api",
      {},
      "From a selected folder.",
    );
    const reads = { count: 0 };
    const source = new FileListFolderSource([
      folderFile(".agent-collab", marker),
      folderFile(messagePath, text, reads),
    ]);

    const loader = new Loader(source);
    await loader.open();

    expect(loader.getSnapshot().items).toMatchObject([
      {
        kind: "message",
        message: { path: messagePath, body: { lines: ["From a selected folder."] } },
      },
    ]);
    expect(reads.count).toBe(1);
    const head = await source.head(null);
    if (head === "not-modified") throw new Error("Expected a snapshot head");
    const parent = messagePath.slice(0, messagePath.lastIndexOf("/"));
    const entries = await source.listDirectory(head.revision, parent);
    const entry = entries.find((candidate) => candidate.path === messagePath);
    if (entry === undefined) throw new Error("Expected the message file to be listed");
    await source.readFile(entry);
    expect(reads.count).toBe(1);
  });

  it("skips .git before applying snapshot limits or reading its files", async () => {
    const gitReads = { count: 0 };
    const source = new FileListFolderSource(
      [
        folderFile(".agent-collab", "collab-protocol: 1\ninbox-layout: flat\n"),
        folderFile(".git/objects/pack/history.pack", "history", gitReads),
      ],
      { maxFiles: 1, maxBytes: 40 },
    );

    const head = await source.head(null);
    expect(head).not.toBe("not-modified");
    expect(
      await source.listDirectory(head === "not-modified" ? "" : head.revision, ""),
    ).toHaveLength(1);
    expect(gitReads.count).toBe(0);
  });

  it("rejects an oversized folder with the local folder message", () => {
    expect(
      () => new FileListFolderSource([folderFile("inbox/a.md", "123456789")], { maxBytes: 8 }),
    ).toThrowError("This folder is too large to read. Choose the clone folder itself.");
  });

  it("rejects file-count overflow", () => {
    expect(
      () =>
        new FileListFolderSource([folderFile("inbox/a.md", "a"), folderFile("inbox/b.md", "b")], {
          maxFiles: 1,
        }),
    ).toThrowError("This folder is too large to read. Choose the clone folder itself.");
  });

  it("rejects a file larger than the shared 1 MiB limit", () => {
    expect(
      () => new FileListFolderSource([folderFile("inbox/large.md", "x".repeat(1024 * 1024 + 1))]),
    ).toThrow(SourceError);
  });

  it.each(["../outside.md", "inbox/../outside.md"])("rejects hostile relative path %s", (path) => {
    expect(() => new FileListFolderSource([folderFile(path, "unsafe")])).toThrow(SourceError);
  });

  it.each(["/absolute.md", "C:/absolute.md"])("rejects absolute path %s", (path) => {
    expect(() => new FileListFolderSource([folderFile(path, "unsafe", { count: 0 }, "")])).toThrow(
      SourceError,
    );
  });

  it("rejects duplicate paths even when the File objects differ", () => {
    expect(
      () =>
        new FileListFolderSource([
          folderFile("inbox/same.md", "first"),
          folderFile("inbox/same.md", "second"),
        ]),
    ).toThrow(SourceError);
  });
});

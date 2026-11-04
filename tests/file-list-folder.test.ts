import { describe, expect, it } from "vitest";

import { Loader } from "../src/loader/loader";
import { TopicSession } from "../src/loader/topic-session";
import { deriveQuestionStates } from "../src/message/questions";
import { FileListFolderSource, filesFromFolderDrop } from "../src/source/file-list-folder";
import { SourceError } from "../src/source/types";
import { messageText } from "./support";

function folderFile(
  path: string,
  content: string,
  reads = { count: 0 },
  root = "clone",
  lastModified = 1_800_000_000_000,
): File {
  const file = new File([content], path.split("/").at(-1) ?? "", {
    lastModified,
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

interface DropEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  file?(success: (file: File) => void, failure?: (error: DOMException) => void): void;
  createReader?(): {
    readEntries(
      success: (entries: DropEntry[]) => void,
      failure?: (error: DOMException) => void,
    ): void;
  };
}

function droppedFile(name: string, content: string, onRead?: () => void): DropEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(success) {
      onRead?.();
      success(new File([content], name));
    },
  };
}

function droppedDirectory(
  name: string,
  children: readonly DropEntry[],
  onOpen?: () => void,
): DropEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      onOpen?.();
      let index = 0;
      return {
        readEntries(success) {
          const batch = children.slice(index, index + 2);
          index += batch.length;
          success([...batch]);
        },
      };
    },
  };
}

function dataTransfer(entry: DropEntry): DataTransfer {
  return {
    items: [{ webkitGetAsEntry: () => entry }],
    files: [],
  } as unknown as DataTransfer;
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

  it("keeps question state unknown when it synthesizes a missing topic marker", async () => {
    const id = "2026-11-04T0900-alice-agent-api-01";
    const source = new FileListFolderSource([
      folderFile(
        `topics/api/inbox/2026-11/${id}.md`,
        messageText(id, "alice-agent", "api", { type: "question", replies: "any" }, "Question."),
      ),
    ]);
    const loader = new Loader(source);
    await loader.open();
    const snapshot = loader.getSnapshot();
    const messages = snapshot.items.flatMap((item) =>
      item.kind === "message" ? [item.message] : [],
    );

    expect(snapshot.rosterKnown).toBe(false);
    expect(
      deriveQuestionStates(messages, snapshot.participants, snapshot.formerParticipants, {
        rosterKnown: snapshot.rosterKnown,
      })[0],
    ).toMatchObject({ state: "unknown", progress: null });
  });

  it.each([
    ["flat", "inbox/2026-10-01T0901-alice-agent-api-01.md"],
    ["monthly", "inbox/2026-10/2026-10-01T0901-alice-agent-api-01.md"],
    ["topic", "topics/api/inbox/2026-10/2026-10-01T0901-alice-agent-api-01.md"],
  ])(
    "infers the %s layout when the directory input omits dotfiles",
    async (layout, messagePath) => {
      const id = "2026-10-01T0901-alice-agent-api-01";
      const source = new FileListFolderSource([
        folderFile(messagePath, messageText(id, "alice-agent", "api", {}, "Safari-like input.")),
      ]);

      if (layout === "topic") {
        const session = new TopicSession(source);
        await session.open();
        expect(session.inboxLayout).toBe("topic");
        expect(session.topics()).toMatchObject([{ name: "api", folder: true }]);
        return;
      }

      const loader = new Loader(source);
      await loader.open();
      expect(loader.getSnapshot().items).toMatchObject([
        { kind: "message", message: { path: messagePath } },
      ]);
    },
  );

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

  it("ignores unsafe names in excluded paths before validating the selected clone", async () => {
    const id = "2026-10-01T0901-alice-agent-api-01";
    const source = new FileListFolderSource([
      folderFile("docs/Icon\r", "unrelated"),
      folderFile(".git/x\\y", "ignored"),
      folderFile(`inbox/${id}.md`, messageText(id, "alice-agent", "api")),
    ]);
    const loader = new Loader(source);

    await loader.open();

    expect(loader.getSnapshot().items).toMatchObject([
      { kind: "message", message: { path: `inbox/${id}.md` } },
    ]);
  });

  it.each(["inbox/README.md", "topics/docs/inbox/notes.md"])(
    "does not infer a clone from an arbitrary Markdown file at %s",
    async (path) => {
      const source = new FileListFolderSource([folderFile(path, "not a message")]);

      await expect(new Loader(source).open()).rejects.toMatchObject({ code: "no-marker" });
    },
  );

  it("still rejects unsafe names inside included clone paths", () => {
    expect(() => new FileListFolderSource([folderFile("inbox/odd\r.md", "unsafe")])).toThrow(
      SourceError,
    );
  });

  it("uses message-file timestamps rather than repository metadata for last changed", () => {
    const messageTime = Date.now() - 5_000;
    const markerTime = Date.now();
    const source = new FileListFolderSource([
      folderFile(
        ".agent-collab",
        "collab-protocol: 1\ninbox-layout: flat\n",
        { count: 0 },
        "clone",
        markerTime,
      ),
      folderFile(
        "inbox/2026-10-01T0901-alice-agent-api-01.md",
        messageText("2026-10-01T0901-alice-agent-api-01", "alice-agent", "api"),
        { count: 0 },
        "clone",
        messageTime,
      ),
    ]);

    expect(source.lastChanged()).toEqual(new Date(messageTime));
  });

  it("rejects an oversized folder with the local folder message", () => {
    expect(
      () => new FileListFolderSource([folderFile("inbox/a.md", "123456789")], { maxBytes: 8 }),
    ).toThrow("This folder is too large to read. Choose the clone folder itself.");
  });

  it("rejects file-count overflow", () => {
    expect(
      () =>
        new FileListFolderSource([folderFile("inbox/a.md", "a"), folderFile("inbox/b.md", "b")], {
          maxFiles: 1,
        }),
    ).toThrow("This folder is too large to read. Choose the clone folder itself.");
  });

  it("counts unrelated files toward the entry cap but not the selected-file byte cap", () => {
    const id = "2026-10-01T0901-alice-agent-api-01";
    const message = folderFile(`inbox/${id}.md`, messageText(id, "alice-agent", "api"));
    const unrelated = folderFile("docs/large.txt", "x".repeat(200));

    expect(
      () =>
        new FileListFolderSource([folderFile("docs/readme.txt", "a"), message], { maxFiles: 1 }),
    ).toThrow("This folder is too large to read. Choose the clone folder itself.");
    expect(
      () => new FileListFolderSource([unrelated, message], { maxBytes: message.size }),
    ).not.toThrow();
  });

  it.each(["directory input", "entry-based folder drop"])(
    "keeps a topic named build in the %s path",
    async (selection) => {
      const id = "2026-11-04T0900-alice-agent-api-01";
      const marker = "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent\n";
      const text = messageText(id, "alice-agent", "build", {}, "The build topic is present.");
      const files =
        selection === "directory input"
          ? [
              folderFile(".agent-collab", marker),
              folderFile(`topics/build/inbox/2026-11/${id}.md`, text),
            ]
          : await filesFromFolderDrop(
              dataTransfer(
                droppedDirectory("clone", [
                  droppedFile(".agent-collab", marker),
                  droppedDirectory("topics", [
                    droppedDirectory("build", [
                      droppedDirectory("inbox", [
                        droppedDirectory("2026-11", [droppedFile(`${id}.md`, text)]),
                      ]),
                    ]),
                  ]),
                ]),
              ),
            );
      const loader = new Loader(new FileListFolderSource(files));
      await loader.open();

      expect(loader.getSnapshot().items).toMatchObject([
        {
          kind: "message",
          message: { path: `topics/build/inbox/2026-11/${id}.md` },
        },
      ]);
    },
  );

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

  it("skips dropped .git directories before opening them and loads the remaining files", async () => {
    let gitReaders = 0;
    const id = "2026-10-01T0901-alice-agent-api-01";
    const files = await filesFromFolderDrop(
      dataTransfer(
        droppedDirectory("clone", [
          droppedFile(".agent-collab", "collab-protocol: 1\ninbox-layout: flat\n"),
          droppedDirectory(".git", [droppedFile("history.pack", "history")], () => {
            gitReaders += 1;
            throw new Error("ignored directory was opened");
          }),
          droppedDirectory("node_modules", [droppedFile("package.js", "dependency")], () => {
            gitReaders += 1;
            throw new Error("ignored directory was opened");
          }),
          droppedDirectory("inbox", [
            droppedFile(`${id}.md`, messageText(id, "alice-agent", "api")),
          ]),
        ]),
      ),
    );

    const loader = new Loader(new FileListFolderSource(files));
    await loader.open();

    expect(gitReaders).toBe(0);
    expect(loader.getSnapshot().items).toMatchObject([
      { kind: "message", message: { path: `inbox/${id}.md` } },
    ]);
  });

  it("skips unsafe names in irrelevant dropped folders before validating included paths", async () => {
    const id = "2026-10-01T0901-alice-agent-api-01";
    const files = await filesFromFolderDrop(
      dataTransfer(
        droppedDirectory("clone", [
          droppedDirectory("docs", [droppedFile("Icon\r", "unrelated")]),
          droppedDirectory("inbox", [
            droppedFile(`${id}.md`, messageText(id, "alice-agent", "api")),
          ]),
        ]),
      ),
    );

    const loader = new Loader(new FileListFolderSource(files));
    await loader.open();
    expect(loader.getSnapshot().items).toMatchObject([
      { kind: "message", message: { path: `inbox/${id}.md` } },
    ]);
  });

  it("rejects unsafe names under included dropped paths", async () => {
    const transfer = dataTransfer(
      droppedDirectory("clone", [droppedDirectory("inbox", [droppedFile("odd\r.md", "unsafe")])]),
    );

    await expect(filesFromFolderDrop(transfer)).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("filters unsafe names from ignored paths in a FileList drop before validation", async () => {
    const id = "2026-10-01T0901-alice-agent-api-01";
    const files = await filesFromFolderDrop({
      items: [],
      files: [
        folderFile("docs/Icon\r", "unrelated"),
        folderFile(".git/x\\y", "ignored"),
        folderFile(`inbox/${id}.md`, messageText(id, "alice-agent", "api")),
      ],
    } as unknown as DataTransfer);

    const loader = new Loader(new FileListFolderSource(files));
    await loader.open();
    expect(loader.getSnapshot().items).toMatchObject([
      { kind: "message", message: { path: `inbox/${id}.md` } },
    ]);
  });

  it("counts safe unrelated files toward FileList drop limits", async () => {
    const id = "2026-10-01T0901-alice-agent-api-01";
    const transfer = {
      items: [],
      files: [
        folderFile("docs/readme.txt", "a"),
        folderFile(`inbox/${id}.md`, messageText(id, "alice-agent", "api")),
      ],
    } as unknown as DataTransfer;

    await expect(filesFromFolderDrop(transfer, { maxEntries: 1 })).rejects.toMatchObject({
      kind: "too-large",
    });
    await expect(filesFromFolderDrop(transfer, { maxBytes: 8 })).rejects.toMatchObject({
      kind: "too-large",
    });
  });

  it("counts only selected file bytes in the FileList drop fallback", async () => {
    const id = "2026-10-01T0901-alice-agent-api-01";
    const message = folderFile(`inbox/${id}.md`, messageText(id, "alice-agent", "api"));
    const transfer = {
      items: [],
      files: [folderFile("docs/large.txt", "x".repeat(200)), message],
    } as unknown as DataTransfer;

    await expect(filesFromFolderDrop(transfer, { maxBytes: message.size })).resolves.toHaveLength(
      1,
    );
  });

  it("counts only selected file bytes in entry-based folder drops", async () => {
    const id = "2026-10-01T0901-alice-agent-api-01";
    const marker = "collab-protocol: 1\ninbox-layout: flat\nparticipants: alice-agent\n";
    const message = messageText(id, "alice-agent", "api");
    const transfer = dataTransfer(
      droppedDirectory("clone", [
        droppedFile(".agent-collab", marker),
        droppedFile("README.md", "x".repeat(200)),
        droppedDirectory("inbox", [droppedFile(`${id}.md`, message)]),
      ]),
    );

    await expect(
      filesFromFolderDrop(transfer, { maxBytes: marker.length + message.length }),
    ).resolves.toHaveLength(2);
  });

  it("stops walking a dropped folder as soon as its size cap is exceeded", async () => {
    let laterFiles = 0;
    const transfer = dataTransfer(
      droppedDirectory("clone", [
        droppedDirectory("inbox", [
          droppedFile("large.md", "larger than the test cap"),
          droppedFile("later.md", "not reached", () => {
            laterFiles += 1;
          }),
        ]),
      ]),
    );

    await expect(filesFromFolderDrop(transfer, { maxBytes: 1 })).rejects.toMatchObject({
      kind: "too-large",
    });
    expect(laterFiles).toBe(0);
  });

  it("stops dropped-folder traversal at the shared entry cap", async () => {
    let fileReads = 0;
    const transfer = dataTransfer(
      droppedDirectory("clone", [
        droppedDirectory("inbox", [droppedFile("message.md", "message", () => (fileReads += 1))]),
      ]),
    );

    await expect(filesFromFolderDrop(transfer, { maxEntries: 2 })).rejects.toMatchObject({
      kind: "too-large",
    });
    expect(fileReads).toBe(0);
  });

  it("counts unrelated entry-based drop files toward the entry cap", async () => {
    let unrelatedReads = 0;
    const transfer = dataTransfer(
      droppedDirectory("clone", [
        droppedFile("README.md", "unrelated", () => (unrelatedReads += 1)),
        droppedDirectory("inbox", [droppedFile("message.md", "message")]),
      ]),
    );

    await expect(filesFromFolderDrop(transfer, { maxEntries: 3 })).rejects.toMatchObject({
      kind: "too-large",
    });
    expect(unrelatedReads).toBe(0);
  });
});

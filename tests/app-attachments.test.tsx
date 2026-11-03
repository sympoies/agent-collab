// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { SourceError, type DirectoryEntry, type MessageSource } from "../src/source/types";
import { App } from "../src/ui/App";
import {
  CSV_PREVIEW_COLUMNS,
  CSV_PREVIEW_ROWS,
  formatSize,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
} from "../src/ui/Attachments";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText, pngBytes, tEn } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const FIRST = "2026-10-01T0900-alice-agent-api-01";
const SECOND = "2026-10-01T0910-bob-agent-ops-01";
const hostile = "javascript:alert(1)";
const refs = [
  "topics/api/fields.md",
  "topics/api/data.csv",
  "topics/api/notes.txt",
  "topics/api/blob.bin",
  "topics/api/huge.txt",
  "topics/api/gone.md",
  "https://docs.example.com/guide?x=1",
  SECOND,
  "2026-09-09T0900-carol-agent-api-01",
  hostile,
  "topics/../escape.md",
].join(", ");

const files: Record<string, string> = {
  ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n",
  [`inbox/${FIRST}.md`]: messageText(FIRST, "alice-agent", "api", { refs }, "See the files."),
  [`inbox/${SECOND}.md`]: messageText(SECOND, "bob-agent", "ops", {}, "Ops note."),
  "topics/api/fields.md": "# Field list\n\n- **id** is required\n\n<script>alert(1)</script>\n",
  "topics/api/data.csv": [
    "name,note",
    ...Array.from({ length: 150 }, (_, i) => `row${String(i)},"a, b"`),
  ].join("\n"),
  "topics/api/notes.txt": "plain <b>text</b> notes",
  "topics/api/blob.bin": "binary",
  "topics/api/huge.txt": "x".repeat(TEXT_PREVIEW_MAX_BYTES + 1),
};

describe("attachments", () => {
  let mounted: { host: HTMLElement; root: Root } | null = null;

  afterEach(() => {
    if (mounted !== null) {
      const { root } = mounted;
      act(() => {
        root.unmount();
      });
    }
    mounted = null;
    document.body.replaceChildren();
    window.location.hash = "";
  });

  async function render(
    source: MessageSource = new FixtureSource(files),
    pageSize = 50,
  ): Promise<HTMLElement> {
    const loader = new Loader(source, { pageSize });
    await loader.open();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={loader}
            title="Repo"
            selfNames={new Set()}
            identity={{ storage: null, key: "test" }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    return host;
  }

  async function open(host: HTMLElement, name: string): Promise<HTMLElement> {
    const card = [...host.querySelectorAll<HTMLDetailsElement>("details.file-card")].find(
      (node) => node.querySelector(".file-name")?.textContent === name,
    );
    expect(card, `card ${name}`).toBeDefined();
    await act(async () => {
      if (card !== undefined) card.open = true;
      card?.dispatchEvent(new Event("toggle"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return card as HTMLElement;
  }

  it("shows each ref as a chip: files as cards, URLs by host, unsafe text as plain text", async () => {
    const host = await render();
    const list = host.querySelector(`#msg-${FIRST} .refs`);
    expect(
      [...(list?.querySelectorAll(".file-card .file-name") ?? [])].map((n) => n.textContent),
    ).toEqual(["fields.md", "data.csv", "notes.txt", "blob.bin", "huge.txt", "gone.md"]);
    expect([...(list?.querySelectorAll(".file-badge") ?? [])].map((n) => n.textContent)).toEqual([
      "MD",
      "CSV",
      "TXT",
      "FILE",
      "TXT",
      "MD",
    ]);
    const link = list?.querySelector<HTMLAnchorElement>('a[href^="https://docs.example.com"]');
    expect(link?.textContent).toBe("docs.example.com");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("target")).toBe("_blank");
    // A hostile ref is text, never a link; an unloaded message id is not a link either.
    expect(list?.querySelector(`a[href^="javascript"]`)).toBeNull();
    expect(list?.textContent).toContain(hostile);
    expect(list?.textContent).toContain("topics/../escape.md");
    expect(list?.textContent).toContain("(not loaded)");
    // Nothing is requested before a card is opened.
    expect(list?.querySelector(".file-body")).toBeNull();
  });

  it("previews Markdown as sanitized elements and CSV as a capped table", async () => {
    const host = await render();
    const md = await open(host, "fields.md");
    expect(md.querySelector(".file-meta")?.textContent).toContain("topics/api/fields.md");
    expect(md.querySelector("h1")?.textContent).toBe("Field list");
    expect(md.querySelector("strong")?.textContent).toBe("id");
    expect(md.querySelector("script")).toBeNull();
    expect(md.textContent).toContain("<script>alert(1)</script>");

    const csv = await open(host, "data.csv");
    expect(csv.querySelectorAll("th")).toHaveLength(2);
    expect(csv.querySelectorAll("tbody tr")).toHaveLength(CSV_PREVIEW_ROWS);
    expect(csv.querySelector("tbody td:nth-child(2)")?.textContent).toBe("a, b");
    expect(csv.textContent).toContain("Showing the first 100 of 150 rows.");

    const txt = await open(host, "notes.txt");
    expect(txt.querySelector("pre")?.textContent).toBe("plain <b>text</b> notes");
    expect(txt.querySelector("b")).toBeNull();
  });

  it("shows metadata for an unknown type, a too-large file and a missing file", async () => {
    const host = await render();
    const other = await open(host, "blob.bin");
    expect(other.textContent).toContain("6 B");
    expect(other.textContent).toContain("No preview for this file type.");

    const huge = await open(host, "huge.txt");
    expect(huge.textContent).toContain("Too large to preview");
    expect(huge.querySelector("pre")).toBeNull();

    const gone = await open(host, "gone.md");
    expect(gone.textContent).toContain("not in the repository at this revision");
  });

  it("offers an open-in-provider link from the source, without naming the provider in the UI code", async () => {
    const base = new FixtureSource(files);
    const source: MessageSource = {
      head: (previous) => base.head(previous),
      listDirectory: (revision, path) => base.listDirectory(revision, path),
      readFile: (entry: DirectoryEntry) => base.readFile(entry),
      rateLimit: () => null,
      webLink: (path) => ({ url: `https://code.example.com/blob/${path}`, label: "Example" }),
    };
    const host = await render(source);
    const other = await open(host, "blob.bin");
    const link = other.querySelector<HTMLAnchorElement>("a.open-link");
    expect(link?.textContent).toBe("Open in Example");
    expect(link?.getAttribute("href")).toBe("https://code.example.com/blob/topics/api/blob.bin");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("jumps to a referenced message and highlights it through the hash", async () => {
    const host = await render();
    const chip = [...host.querySelectorAll<HTMLAnchorElement>(`#msg-${FIRST} .refs a.chip`)].find(
      (node) => node.getAttribute("href") === `#msg-${SECOND}`,
    );
    expect(chip?.textContent).toContain("Message 2026-10-01 09:10");
    await act(async () => {
      chip?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(window.location.hash).toBe(`#msg-${SECOND}`);
    expect(host.querySelector(`#msg-${SECOND}`)).not.toBeNull();
  });

  it("lists every file and link of the conversation in the Files view, once each", async () => {
    const host = await render();
    const filesButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Files");
    await act(async () => {
      filesButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector("#conversation-heading")?.textContent).toBe("Files");
    const names = [...host.querySelectorAll(".files .file-name")].map((node) => node.textContent);
    expect(names.sort()).toEqual([
      "blob.bin",
      "data.csv",
      "fields.md",
      "gone.md",
      "huge.txt",
      "notes.txt",
    ]);
    expect(host.querySelectorAll(".files a.chip")).toHaveLength(1);
    expect(host.querySelector(".files .file-from")?.textContent).toContain("alice-agent · #api");
  });

  const IMG = "2026-10-02T0900-alice-agent-api-01";
  const imageRepo = (refs = "topics/api/pic.png, https://evil.example/remote.png") => ({
    ".agent-collab": "collab-protocol: 1\n",
    [`inbox/${IMG}.md`]: messageText(IMG, "alice-agent", "api", { refs }, "An image."),
    "topics/api/pic.png": "x",
    "topics/api/big.png": "y",
  });

  /** A source whose listed files have these bytes (and sizes), like a provider's binary blobs. */
  function binarySource(binary: Record<string, Uint8Array>, sizes: Record<string, number> = {}) {
    const base = new FixtureSource(imageRepo("topics/api/pic.png, topics/api/big.png"));
    const reads: string[] = [];
    const source: MessageSource = {
      head: (previous) => base.head(previous),
      listDirectory: async (revision, path) =>
        (await base.listDirectory(revision, path)).map((entry) =>
          entry.path in binary
            ? { ...entry, size: sizes[entry.path] ?? binary[entry.path]?.length ?? 0 }
            : entry,
        ),
      readFile: (entry) => base.readFile(entry),
      readBytes: (entry) => {
        reads.push(entry.path);
        return Promise.resolve(binary[entry.path] ?? new Uint8Array());
      },
      rateLimit: () => null,
    };
    return { source, reads };
  }

  async function toggle(card: HTMLElement, open: boolean): Promise<void> {
    await act(async () => {
      (card as HTMLDetailsElement).open = open;
      card.dispatchEvent(new Event("toggle"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("creates image blob URLs only from bytes read through the source, revokes them on close and never reuses a stale one", async () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const createSpy = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      created.push(blob as Blob);
      return `blob:test-${String(created.length)}`;
    });
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(url);
    });
    try {
      const png = pngBytes(10, 10);
      const { source, reads } = binarySource({ "topics/api/pic.png": png });
      const host = await render(source);
      const card = await open(host, "pic.png");
      expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:test-1");
      expect(created[0]?.type).toBe("image/png");
      expect([...new Uint8Array((await created[0]?.arrayBuffer()) ?? new ArrayBuffer(0))]).toEqual([
        ...png,
      ]);
      // A URL in refs is a link chip; it never becomes an image source.
      expect(host.querySelector(`img[src^="https"]`)).toBeNull();
      expect(revoked).toEqual([]);

      await toggle(card, false);
      expect(card.querySelector("img")).toBeNull();
      expect(revoked).toEqual(["blob:test-1"]);

      // Opening again reads nothing new from the source, and uses a fresh URL, not the revoked one.
      await toggle(card, true);
      expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:test-2");
      await toggle(card, false);
      expect(revoked).toEqual(["blob:test-1", "blob:test-2"]);
      expect(created).toHaveLength(2);
      expect(reads).toEqual(["topics/api/pic.png"]);
    } finally {
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });

  it("revokes the blob URL when the view goes away", async () => {
    const revoked: string[] = [];
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:gone-1");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(url);
    });
    try {
      const { source } = binarySource({ "topics/api/pic.png": pngBytes(2, 2) });
      const host = await render(source);
      await open(host, "pic.png");
      expect(revoked).toEqual([]);
      act(() => {
        mounted?.root.unmount();
      });
      mounted = null;
      expect(revoked).toEqual(["blob:gone-1"]);
    } finally {
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });

  it("refuses an image above the pixel cap, one with an unreadable header and one above the byte cap", async () => {
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:never");
    try {
      const { source } = binarySource(
        {
          "topics/api/pic.png": pngBytes(8000, 8000),
          "topics/api/big.png": pngBytes(1, 1),
        },
        { "topics/api/big.png": IMAGE_PREVIEW_MAX_BYTES + 1 },
      );
      const host = await render(source);
      const bomb = await open(host, "pic.png");
      expect(bomb.textContent).toContain("Too many pixels to preview (8000\u00d78000)");
      expect(bomb.querySelector("img")).toBeNull();
      const big = await open(host, "big.png");
      expect(big.textContent).toContain("Too large to preview");
      expect(createSpy).not.toHaveBeenCalled();

      const bad = binarySource({ "topics/api/pic.png": Uint8Array.from([1, 2, 3, 4]) });
      act(() => {
        mounted?.root.unmount();
      });
      mounted = null;
      document.body.replaceChildren();
      const badHost = await render(bad.source);
      const unreadable = await open(badHost, "pic.png");
      expect(unreadable.textContent).toContain("The image size could not be read");
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
    }
  });

  it("does not preview a file whose size the source does not report", async () => {
    const base = new FixtureSource(files);
    const reads: string[] = [];
    const source: MessageSource = {
      head: (previous) => base.head(previous),
      listDirectory: async (revision, path) =>
        (await base.listDirectory(revision, path)).map((entry) => ({
          name: entry.name,
          path: entry.path,
          kind: entry.kind,
          objectId: entry.objectId,
        })),
      readFile: (entry) => {
        if (entry.path.startsWith("topics/")) reads.push(entry.path);
        return base.readFile(entry);
      },
      rateLimit: () => null,
    };
    const host = await render(source);
    const card = await open(host, "fields.md");
    expect(card.textContent).toContain("The file size is unknown, so it is not previewed.");
    expect(card.querySelector("h1")).toBeNull();
    expect(reads).toEqual([]);
  });

  it.each([
    [
      "a rate limit",
      new SourceError("rate-limited", "topics/api/fields.md", 403),
      "request limit is reached",
    ],
    [
      "a failed read",
      new SourceError("unreachable", "topics/api/fields.md"),
      "Could not load this file.",
    ],
  ])("shows %s once, without retrying by itself", async (_name, error, message) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    try {
      const base = new FixtureSource(files);
      let reads = 0;
      const source: MessageSource = {
        head: (previous) => base.head(previous),
        listDirectory: (revision, path) => base.listDirectory(revision, path),
        readFile: (entry) => {
          if (!entry.path.startsWith("topics/")) return base.readFile(entry);
          reads += 1;
          return Promise.reject(error);
        },
        rateLimit: () => null,
      };
      vi.useRealTimers();
      const host = await render(source);
      const card = await open(host, "fields.md");
      expect(card.textContent).toContain(message);
      expect(card.querySelector("h1")).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the columns of a wide CSV and says so", async () => {
    const wide = Array.from({ length: CSV_PREVIEW_COLUMNS + 30 }, (_, i) => `c${String(i)}`).join(
      ",",
    );
    const host = await render(
      new FixtureSource({ ...files, "topics/api/data.csv": `${wide}\n${wide}` }),
    );
    const card = await open(host, "data.csv");
    expect(card.querySelectorAll("th")).toHaveLength(CSV_PREVIEW_COLUMNS);
    expect(card.textContent).toContain(
      `Showing the first ${String(CSV_PREVIEW_COLUMNS)} of ${String(CSV_PREVIEW_COLUMNS + 30)} columns.`,
    );
  });

  it("switches to the topic of a referenced message in another topic", async () => {
    const host = await render();
    const topicButton = [...host.querySelectorAll("button")].find((b) =>
      b.textContent.startsWith("#api"),
    );
    await act(async () => {
      topicButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector("#conversation-heading")?.textContent).toBe("#api");
    expect(host.querySelector(`#msg-${SECOND}`)).toBeNull();
    const chip = host.querySelector<HTMLAnchorElement>(
      `#msg-${FIRST} .refs a[href="#msg-${SECOND}"]`,
    );
    await act(async () => {
      chip?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(host.querySelector("#conversation-heading")?.textContent).toBe("#ops");
    expect(window.location.hash).toBe(`#msg-${SECOND}`);
  });

  it("jumps from the Files view back to the message that references a file", async () => {
    const host = await render();
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Files")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      host
        .querySelector(".files .file-from")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(host.querySelector("#conversation-heading")?.textContent).toBe("All conversations");
    expect(host.querySelector(".files")).toBeNull();
    expect(window.location.hash).toBe(`#msg-${FIRST}`);
  });

  it("drops a jump whose target is not rendered instead of keeping it for later", async () => {
    const ACK = "2026-10-01T0905-bob-agent-api-02";
    const repository = {
      ...files,
      [`inbox/${FIRST}.md`]: messageText(
        FIRST,
        "alice-agent",
        "api",
        { refs: ACK },
        "See the ack.",
      ),
      // A plain acknowledgement is a receipt, not a row, so there is nothing to scroll to.
      [`inbox/${ACK}.md`]: messageText(
        ACK,
        "bob-agent",
        "api",
        { type: "ack", reply_to: FIRST, to: "alice-agent" },
        "Received.",
      ),
    };
    const host = await render(new FixtureSource(repository));
    const chip = host.querySelector<HTMLAnchorElement>(`#msg-${FIRST} .refs a[href="#msg-${ACK}"]`);
    expect(chip).not.toBeNull();
    await act(async () => {
      chip?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(window.location.hash).toBe("");
    // Later manual navigation does not scroll to, or highlight, anything.
    for (const label of ["Files", "All"]) {
      await act(async () => {
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent.startsWith(label))
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
    }
    expect(window.location.hash).toBe("");
  });

  it("lists a file once however often it is referenced", async () => {
    const LATER = "2026-10-02T0900-bob-agent-api-01";
    const repository = {
      ...files,
      [`inbox/${FIRST}.md`]: messageText(
        FIRST,
        "alice-agent",
        "api",
        {
          refs: "topics/api/fields.md, topics/api/fields.md, https://docs.example.com/a, https://docs.example.com/a",
        },
        "Twice in one message.",
      ),
      [`inbox/${LATER}.md`]: messageText(
        LATER,
        "bob-agent",
        "api",
        { refs: "topics/api/fields.md" },
        "Again.",
      ),
    };
    const host = await render(new FixtureSource(repository));
    // Both cards of the message stay (the message shows what it references) ...
    expect(host.querySelectorAll(`#msg-${FIRST} .file-card`)).toHaveLength(2);
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Files")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    // ... while the Files view has each file and link once, from the newest reference.
    expect(host.querySelectorAll(".files .file-card")).toHaveLength(1);
    expect(host.querySelectorAll(".files a.chip")).toHaveLength(1);
    expect(host.querySelector(".files .file-from")?.textContent).toContain("bob-agent");
  });

  it("offers older messages in the Files view and says only loaded messages are listed", async () => {
    const host = await render(new FixtureSource(files), 1);
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Files")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Only files and links from the loaded messages are listed.");
    expect(host.querySelector("button.older")?.textContent).toBe("Load older messages");
  });

  it("shows no open link when the source has no web page for files", async () => {
    const host = await render();
    const card = await open(host, "blob.bin");
    expect(card.querySelector("a.open-link")).toBeNull();
  });
});

describe("formatSize", () => {
  it.each([
    [null, "size unknown"],
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [1024 * 1024 - 1, "1024.0 KB"],
    [1024 * 1024, "1.0 MB"],
    [5 * 1024 * 1024 + 512 * 1024, "5.5 MB"],
  ])("formats %s as %s", (size, text) => {
    expect(formatSize(size, tEn)).toBe(text);
  });
});

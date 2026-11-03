// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import type { DirectoryEntry, MessageSource } from "../src/source/types";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const FIRST = "2026-10-01T0900-alice-agent-api-01";
const SECOND = "2026-10-01T0910-bob-agent-ops-01";
const hostile = "javascript:alert(1)";
const refs = [
  "topics/api/fields.md",
  "topics/api/data.csv",
  "topics/api/notes.txt",
  "topics/api/blob.bin",
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
  "topics/api/data.csv": 'name,note\nrow,"a, b"\n',
  "topics/api/notes.txt": "plain <b>text</b> notes",
  "topics/api/blob.bin": "binary",
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

  async function render(source: MessageSource = new FixtureSource(files)): Promise<HTMLElement> {
    const loader = new Loader(source);
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
    ).toEqual(["fields.md", "data.csv", "notes.txt", "blob.bin", "gone.md"]);
    expect([...(list?.querySelectorAll(".file-badge") ?? [])].map((n) => n.textContent)).toEqual([
      "MD",
      "CSV",
      "TXT",
      "FILE",
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

  it("shows the size and path when a card is opened, and renders no file content", async () => {
    const host = await render();
    const md = await open(host, "fields.md");
    expect(md.querySelector(".file-meta")?.textContent).toContain("topics/api/fields.md");
    expect(md.querySelector(".file-meta")?.textContent).toMatch(/\d+ B/);
    // Content is not previewed in this slice: no headings, elements from the file, or images.
    expect(md.querySelector("h1, script, img, pre")).toBeNull();
    expect(md.textContent).not.toContain("Field list");

    const other = await open(host, "blob.bin");
    expect(other.textContent).toContain("6 B");
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
    expect(names.sort()).toEqual(["blob.bin", "data.csv", "fields.md", "gone.md", "notes.txt"]);
    expect(host.querySelectorAll(".files a.chip")).toHaveLength(1);
    expect(host.querySelector(".files .file-from")?.textContent).toContain("alice-agent · #api");
  });
});

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Secret } from "../src/credentials/secret";
import { MemoryStore } from "../src/credentials/store";
import { FixtureSource } from "../src/source/fixture";
import type { FolderMemory, RememberedFolder } from "../src/source/folder-memory";
import { forgetStored } from "../src/settings/forget-stored";
import { Root, type LocalFolderOpen } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { flat, MARKER, messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ID = "2026-10-01T0901-alice-agent-api-01";
const files = {
  ".agent-collab": `${MARKER}participants: alice-agent\n`,
  [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "In the source."),
};
const clone = (name: string) => ({ source: new FixtureSource(files), name });

describe("the settings screen as the place to choose a data source", () => {
  let mounted: ReactRoot | null = null;
  afterEach(() => {
    if (mounted !== null) {
      const root = mounted;
      act(() => {
        root.unmount();
      });
    }
    mounted = null;
    document.body.replaceChildren();
  });

  function storageMap(entries: Record<string, string> = {}) {
    const values = new Map(Object.entries(entries));
    return {
      values,
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  }

  async function render(options: {
    memory?: FolderMemory;
    openLocalFolder?: (() => Promise<LocalFolderOpen>) | null;
    storage?: ReturnType<typeof storageMap>;
    credentials?: MemoryStore;
    hosted?: boolean;
  }): Promise<HTMLElement> {
    const storage = options.storage ?? storageMap();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = root;
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <Root
            storage={storage}
            stores={{
              memory: options.credentials ?? new MemoryStore(),
              "browser-encrypted": new MemoryStore(),
            }}
            createSource={() => new FixtureSource({})}
            createDemoSource={() => new FixtureSource(files)}
            createLiveDemoSource={() => new FixtureSource(files)}
            openLocalFolder={options.openLocalFolder ?? null}
            forgetStored={() => {
              forgetStored(storage);
            }}
            {...(options.memory === undefined ? {} : { folderMemory: options.memory })}
            {...(options.hosted === true
              ? { createHostedSource: () => new FixtureSource(files) }
              : {})}
          />
        </ThemeProvider>,
      );
      for (let round = 0; round < 4; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    return host;
  }

  const button = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll("button")].find((candidate) =>
      candidate.textContent.startsWith(text),
    );

  async function click(element: Element | undefined): Promise<void> {
    expect(element).toBeDefined();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (let round = 0; round < 4; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }

  const settingsFromViewer = (host: HTMLElement) =>
    click(host.querySelector('button[aria-label="Settings"]') ?? undefined);

  function remembering(name: string) {
    let kept: string | null = name;
    const calls = { forget: [] as string[] };
    const memory: FolderMemory = {
      load: () => {
        if (kept === null) return Promise.resolve(null);
        const current = kept;
        const found: RememberedFolder = {
          name: current,
          active: false,
          permission: () => Promise.resolve("prompt"),
          request: () => Promise.resolve("granted"),
          open: () => clone(current),
        };
        return Promise.resolve(found);
      },
      save: () => Promise.resolve(),
      setActive: () => Promise.resolve(),
      forget: (folder) => {
        calls.forget.push(folder);
        const hit = kept === folder;
        if (hit) kept = null;
        return Promise.resolve(hit);
      },
    };
    return { memory, calls };
  }

  it("lists the snapshot, GitHub, local folder, live demo and offline demo", async () => {
    const host = await render({ hosted: true, openLocalFolder: () => Promise.resolve(clone("c")) });
    await settingsFromViewer(host);
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect([...host.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Snapshot served with this page",
      "GitHub repository",
      "Local folder",
      "Live demo",
      "Offline demo",
    ]);
    expect(host.querySelector("#github-form")).not.toBeNull();
  });

  it("opens a local folder from Settings", async () => {
    const host = await render({ openLocalFolder: () => Promise.resolve(clone("my-clone")) });
    await click(button(host, "Open another repository"));
    await click(button(host, "Open local folder"));
    expect(host.querySelector("h1")?.textContent).toBe("Local folder: my-clone");
  });

  it("opens the offline demo and the snapshot from Settings", async () => {
    const host = await render({ hosted: true });
    await settingsFromViewer(host);
    await click(button(host, "Open offline demo"));
    expect(host.querySelector("h1")?.textContent).toBe("Demo repository");
    await settingsFromViewer(host);
    await click(button(host, "Open the snapshot"));
    expect(host.querySelector("h1")?.textContent).toBe("Collaboration snapshot");
  });

  it("forgets the folder, the saved repository, the token and every choice, and stays in Settings", async () => {
    const storage = storageMap({
      "agent-collab-viewer.settings": JSON.stringify({
        platform: "github",
        endpoint: "https://api.github.com",
        repository: "alice-org/collab",
        branch: "",
        selfNames: [],
        credentialStorage: "memory",
      }),
      "agent-collab-viewer.identity:local:my-clone": "{}",
      "agent-collab-viewer.view:hosted:https://a.example/": "{}",
      "agent-collab-viewer.locale": "ja",
    });
    const credentials = new MemoryStore();
    await credentials.set(
      "access-token",
      new Secret(JSON.stringify({ endpoint: "https://api.github.com", token: "t" })),
    );
    const { memory, calls } = remembering("my-clone");
    const host = await render({ hosted: true, memory, storage, credentials });
    await settingsFromViewer(host);
    expect(button(host, "Reopen my-clone")).toBeDefined();

    await click(button(host, "Forget what this browser remembers"));
    await click(button(host, "Forget everything"));

    expect(calls.forget).toEqual(["my-clone"]);
    expect([...storage.values.keys()]).toEqual(["agent-collab-viewer.locale"]);
    expect(await credentials.get("access-token")).toBeNull();
    expect(button(host, "Reopen my-clone")).toBeUndefined();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("no longer remembers");
    expect(host.querySelector("#github-form")).not.toBeNull();
  });

  it("keeps everything when the reader cancels", async () => {
    const storage = storageMap({ "agent-collab-viewer.identity:local:x": "{}" });
    const forget = vi.fn();
    const { memory } = remembering("my-clone");
    memory.forget = (folder) => {
      forget(folder);
      return Promise.resolve(true);
    };
    const host = await render({ hosted: true, memory, storage });
    await settingsFromViewer(host);
    await click(button(host, "Forget what this browser remembers"));
    await click(button(host, "Cancel"));
    expect(forget).not.toHaveBeenCalled();
    expect(storage.values.has("agent-collab-viewer.identity:local:x")).toBe(true);
  });
});

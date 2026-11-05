// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../src/credentials/store";
import type { FolderMemory, RememberedFolder } from "../src/source/folder-memory";
import { FixtureSource } from "../src/source/fixture";
import { Root, type LocalFolderOpen } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { flat, MARKER, messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ID = "2026-10-01T0901-alice-agent-api-01";
const files = {
  ".agent-collab": `${MARKER}participants: alice-agent, bob-agent\n`,
  [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "From the local clone."),
};
const clone = (name: string) => ({ source: new FixtureSource(files), name });

type Permission = "granted" | "prompt" | "denied";

/** An in-memory FolderMemory whose remembered folder asks for the given permission. */
function memoryWith(
  start: { name: string; active: boolean; permission: Permission; onRequest?: Permission } | null,
) {
  let kept = start;
  const calls = { request: 0, forget: 0, active: [] as boolean[], saved: [] as string[] };
  const memory: FolderMemory = {
    load: () => {
      const now = kept;
      if (now === null) return Promise.resolve(null);
      const found: RememberedFolder = {
        name: now.name,
        active: now.active,
        permission: () => Promise.resolve(now.permission),
        request: () => {
          calls.request += 1;
          return Promise.resolve(now.onRequest ?? "granted");
        },
        open: () => clone(now.name),
      };
      return Promise.resolve(found);
    },
    save: () => Promise.resolve(),
    setActive: (active) => {
      calls.active.push(active);
      if (kept !== null) kept = { ...kept, active };
      return Promise.resolve();
    },
    forget: () => {
      calls.forget += 1;
      kept = null;
      return Promise.resolve();
    },
  };
  return { memory, calls };
}

describe("Root with a remembered local folder", () => {
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

  async function render(
    memory: FolderMemory,
    openLocalFolder: (() => Promise<LocalFolderOpen>) | null = null,
    storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } = {
      getItem: () => null,
      setItem: () => undefined,
    },
  ): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = root;
    await act(async () => {
      root.render(
        <ThemeProvider storage={storage}>
          <Root
            storage={storage}
            stores={{ memory: new MemoryStore(), "browser-encrypted": new MemoryStore() }}
            createSource={() => new FixtureSource({})}
            createDemoSource={() => new FixtureSource({})}
            createLiveDemoSource={() => new FixtureSource({})}
            openLocalFolder={openLocalFolder}
            folderMemory={memory}
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

  it("reopens the folder of the last session by itself when the permission is still granted", async () => {
    const { memory } = memoryWith({ name: "my-clone", active: true, permission: "granted" });
    const host = await render(memory);
    expect(host.querySelector("h1")?.textContent).toBe("Local folder: my-clone");
    expect(host.textContent).toContain("From the local clone.");
  });

  it("offers Reopen on the welcome screen when the folder is not the last view or needs a prompt", async () => {
    const { memory, calls } = memoryWith({ name: "my-clone", active: true, permission: "prompt" });
    const host = await render(memory);
    expect(host.querySelector("h1")?.textContent).toBe("Collab Viewer");
    expect(calls.request).toBe(0);
    await click(button(host, "Reopen my-clone"));
    expect(calls.request).toBe(1);
    expect(host.querySelector("h1")?.textContent).toBe("Local folder: my-clone");
  });

  it("does not reopen a folder that is no longer the last view, but still offers it", async () => {
    const { memory } = memoryWith({ name: "my-clone", active: false, permission: "granted" });
    const host = await render(memory);
    expect(host.querySelector("h1")?.textContent).toBe("Collab Viewer");
    await click(button(host, "Reopen my-clone"));
    expect(host.querySelector("h1")?.textContent).toBe("Local folder: my-clone");
  });

  it("says so and stays on the welcome screen when permission is refused", async () => {
    const { memory } = memoryWith({
      name: "my-clone",
      active: false,
      permission: "prompt",
      onRequest: "denied",
    });
    const host = await render(memory);
    await click(button(host, "Reopen my-clone"));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Permission to read my-clone was not granted. Choose the folder again.",
    );
    expect(host.querySelector("h1")?.textContent).toBe("Collab Viewer");
  });

  it("forgets the folder on request", async () => {
    const { memory, calls } = memoryWith({ name: "my-clone", active: false, permission: "prompt" });
    const host = await render(memory);
    await click(button(host, "Forget this folder"));
    expect(calls.forget).toBe(1);
    expect(button(host, "Reopen")).toBeUndefined();
  });

  it("shows no Reopen action when nothing is remembered", async () => {
    const { memory } = memoryWith(null);
    const host = await render(memory);
    expect(button(host, "Reopen")).toBeUndefined();
    expect(button(host, "Forget")).toBeUndefined();
  });

  it("remembers a picked folder only after it opened, and marks the last view", async () => {
    const remember = vi.fn(() => Promise.resolve());
    const { memory, calls } = memoryWith(null);
    let next: LocalFolderOpen = {
      source: new FixtureSource({ "a.md": "x" }),
      name: "other",
      remember,
    };
    const host = await render(memory, () => Promise.resolve(next));
    await click(button(host, "Open local folder"));
    expect(remember).not.toHaveBeenCalled();

    next = { ...clone("my-clone"), remember };
    await click(button(host, "Open local folder"));
    expect(remember).toHaveBeenCalledOnce();
    expect(calls.active.at(-1)).toBe(true);
  });

  it("clears the last-view mark when another viewer replaces the folder", async () => {
    const { memory, calls } = memoryWith({ name: "my-clone", active: true, permission: "granted" });
    const host = await render(memory);
    expect(calls.active.at(-1)).toBe(true);
    await click(host.querySelector('button[aria-label="Settings"]') ?? undefined);
    await click(button(host, "Open offline demo"));
    expect(calls.active.at(-1)).toBe(false);
  });

  describe("viewer choices kept per folder name", () => {
    function storageMap() {
      const values = new Map<string, string>();
      return {
        values,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      };
    }

    it("returns to the chosen person after a reload and keeps folders apart", async () => {
      const storage = storageMap();
      const { memory } = memoryWith(null);
      let host = await render(memory, () => Promise.resolve(clone("clone-a")), storage);
      await click(button(host, "Open local folder"));
      const select = host.querySelector<HTMLSelectElement>(".viewing-as select");
      act(() => {
        if (select === null) return;
        select.value = "alice-agent";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect([...storage.values.keys()].some((key) => key.endsWith("local:clone-a"))).toBe(true);
      expect([...storage.values.keys()].every((key) => !key.includes("/"))).toBe(true);

      act(() => {
        mounted?.unmount();
      });
      document.body.replaceChildren();
      host = await render(memory, () => Promise.resolve(clone("clone-a")), storage);
      await click(button(host, "Open local folder"));
      expect(host.querySelector<HTMLSelectElement>(".viewing-as select")?.value).toBe(
        "alice-agent",
      );

      act(() => {
        mounted?.unmount();
      });
      document.body.replaceChildren();
      host = await render(memory, () => Promise.resolve(clone("clone-b")), storage);
      await click(button(host, "Open local folder"));
      expect(host.querySelector<HTMLSelectElement>(".viewing-as select")?.value).toBe("");
    });
  });
});

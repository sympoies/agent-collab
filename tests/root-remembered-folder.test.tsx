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

/** The same folder, but its first listing waits for the gate. */
function gated(open: { source: FixtureSource; name: string }, gate: Promise<void>) {
  const list = open.source.listDirectory.bind(open.source);
  open.source.listDirectory = async (revision, path) => {
    await gate;
    return list(revision, path);
  };
  return open;
}

type Permission = "granted" | "prompt" | "denied";

/** An in-memory FolderMemory whose remembered folder asks for the given permission. */
function memoryWith(
  start: {
    name: string;
    active: boolean;
    permission: Permission;
    onRequest?: Permission;
    /** The folder opens to something that is not a collaboration clone (deleted or moved). */
    unreadable?: boolean;
    /** Reading the folder waits for this, like a slow disk. */
    gate?: Promise<void>;
    /** Another tab replaced the folder: forgetting this name deletes nothing. */
    forgetKeeps?: boolean;
  } | null,
) {
  let kept = start;
  const calls = {
    request: 0,
    forget: 0,
    active: [] as boolean[],
    marks: [] as [boolean, string | null][],
    saved: [] as string[],
  };
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
        open: () => {
          const base =
            now.unreadable === true
              ? { source: new FixtureSource({ "README.md": "moved" }), name: now.name }
              : clone(now.name);
          return now.gate === undefined ? base : gated(base, now.gate);
        },
      };
      return Promise.resolve(found);
    },
    save: () => Promise.resolve(),
    setActive: (active, folder) => {
      calls.active.push(active);
      calls.marks.push([active, folder]);
      if (kept !== null && (folder === null || folder === kept.name)) kept = { ...kept, active };
      return Promise.resolve();
    },
    forget: (folder) => {
      calls.forget += 1;
      if (kept?.name !== folder || kept.forgetKeeps === true) return Promise.resolve(false);
      kept = null;
      return Promise.resolve(true);
    },
  };
  /** What a successful pick does to the store (the real `remember` closure saves the handle). */
  const pick = (name: string) => {
    kept = { name, active: true, permission: "granted" };
  };
  return { memory, calls, pick };
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
    extra: {
      hosted?: () => FixtureSource;
      openLocalFileList?: () => Promise<LocalFolderOpen>;
    } = {},
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
            {...(extra.hosted === undefined ? {} : { createHostedSource: extra.hosted })}
            {...(extra.openLocalFileList === undefined
              ? {}
              : { openLocalFileList: extra.openLocalFileList })}
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

  describe("from the served snapshot", () => {
    const snapshot = () => new FixtureSource(files);
    const openSettings = (host: HTMLElement) =>
      click(host.querySelector('button[aria-label="Settings"]') ?? undefined);

    for (const state of [
      { label: "needs a prompt", active: true, permission: "prompt" as const },
      { label: "is not the last view", active: false, permission: "granted" as const },
    ]) {
      it(`offers Reopen and Forget in Settings when the remembered folder ${state.label}`, async () => {
        const { memory, calls } = memoryWith({ name: "my-clone", ...state });
        const host = await render(memory, null, undefined, { hosted: snapshot });
        expect(host.querySelector("h1")?.textContent).toBe("Collaboration snapshot");
        await openSettings(host);
        expect(button(host, "Reopen my-clone")).toBeDefined();
        expect(host.textContent).toContain("Forget deletes");

        await click(button(host, "Reopen my-clone"));
        expect(host.querySelector("h1")?.textContent).toBe("Local folder: my-clone");
        expect(calls.active.at(-1)).toBe(true);
      });
    }

    it("opens the snapshot without waiting for a folder store that never answers", async () => {
      {
        const never: FolderMemory = {
          load: () => new Promise(() => undefined),
          save: () => Promise.resolve(),
          setActive: () => Promise.resolve(),
          forget: () => Promise.resolve(false),
        };
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        mounted = root;
        act(() => {
          root.render(
            <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
              <Root
                storage={{ getItem: () => null, setItem: () => undefined }}
                stores={{ memory: new MemoryStore(), "browser-encrypted": new MemoryStore() }}
                createSource={() => new FixtureSource({})}
                createDemoSource={() => new FixtureSource({})}
                createLiveDemoSource={() => new FixtureSource({})}
                openLocalFolder={null}
                folderMemory={never}
                createHostedSource={snapshot}
              />
            </ThemeProvider>,
          );
        });
        // The page waits about two seconds for the store, then opens the snapshot.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 2300));
          for (let round = 0; round < 6; round += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        });
        expect(host.querySelector("h1")?.textContent).toBe("Collaboration snapshot");
      }
    }, 8000);

    it("falls back to the snapshot when the remembered folder can no longer be read", async () => {
      const { memory, calls } = memoryWith({
        name: "my-clone",
        active: true,
        permission: "granted",
        unreadable: true,
      });
      const host = await render(memory, null, undefined, { hosted: snapshot });
      expect(host.querySelector("h1")?.textContent).toBe("Collaboration snapshot");
      expect(calls.active.at(-1)).toBe(false);
      await openSettings(host);
      expect(button(host, "Reopen my-clone")).toBeDefined();
      expect(host.querySelector(".remembered-folder [role='alert']")?.textContent).toContain(
        "not a collaboration clone",
      );
    });

    it("marks the folder that failed, and the error stays with it", async () => {
      const { memory, calls } = memoryWith({
        name: "my-clone",
        active: true,
        permission: "granted",
        unreadable: true,
      });
      const host = await render(memory, null, undefined, { hosted: snapshot });
      expect(calls.marks).toContainEqual([false, "my-clone"]);
      expect(host.querySelector("h1")?.textContent).toBe("Collaboration snapshot");
    });

    it("shows why Reopen failed in Settings, until Forget clears it", async () => {
      const { memory } = memoryWith({
        name: "my-clone",
        active: false,
        permission: "granted",
        unreadable: true,
      });
      const host = await render(memory, null, undefined, { hosted: snapshot });
      await openSettings(host);
      await click(button(host, "Reopen my-clone"));
      expect(host.querySelector(".remembered-folder [role='alert']")?.textContent).toContain(
        "not a collaboration clone",
      );
      await click(button(host, "Forget this folder"));
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    it("clears the Reopen failure on Forget even when another folder stays remembered", async () => {
      const { memory } = memoryWith({
        name: "my-clone",
        active: false,
        permission: "granted",
        unreadable: true,
        forgetKeeps: true,
      });
      const host = await render(memory, null, undefined, { hosted: snapshot });
      await openSettings(host);
      await click(button(host, "Reopen my-clone"));
      expect(host.querySelector(".remembered-folder [role='alert']")).not.toBeNull();
      await click(button(host, "Forget this folder"));
      expect(host.querySelector(".remembered-folder")).not.toBeNull();
      expect(host.querySelector(".remembered-folder [role='alert']")).toBeNull();
    });

    it("does not replace what the reader opened while the folder was still being read", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { memory, calls } = memoryWith({
        name: "my-clone",
        active: true,
        permission: "granted",
        unreadable: true,
        gate,
      });
      const host = await render(memory, () => Promise.resolve(clone("other")), undefined, {
        hosted: snapshot,
      });
      await click(button(host, "Open local folder"));
      expect(host.querySelector("h1")?.textContent).toBe("Local folder: other");

      release();
      await act(async () => {
        for (let round = 0; round < 6; round += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
      expect(host.querySelector("h1")?.textContent).toBe("Local folder: other");
      expect(calls.marks).not.toContainEqual([false, "my-clone"]);
    });

    it("says so in Settings when the permission is refused", async () => {
      const { memory } = memoryWith({
        name: "my-clone",
        active: false,
        permission: "prompt",
        onRequest: "denied",
      });
      const host = await render(memory, null, undefined, { hosted: snapshot });
      await openSettings(host);
      await click(button(host, "Reopen my-clone"));
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        "Permission to read my-clone was not granted. Choose the folder again.",
      );
    });

    it("forgets the handle together with the choices made in that folder", async () => {
      const values = new Map<string, string>([
        [
          "agent-collab-viewer.identity:local:my-clone",
          '{"viewingAs":"bob-agent","colors":{},"names":{}}',
        ],
        ["agent-collab-viewer.view:local:my-clone", '{"view":"files","topic":null}'],
        [
          "agent-collab-viewer.identity:local:other",
          '{"viewingAs":"bob-agent","colors":{},"names":{}}',
        ],
      ]);
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      };
      const { memory, calls } = memoryWith({
        name: "my-clone",
        active: false,
        permission: "prompt",
      });
      const host = await render(memory, null, storage, { hosted: snapshot });
      await openSettings(host);
      await click(button(host, "Forget this folder"));
      expect(calls.forget).toBe(1);
      expect(button(host, "Reopen")).toBeUndefined();
      expect(JSON.parse(values.get("agent-collab-viewer.identity:local:my-clone") ?? "{}")).toEqual(
        {
          viewingAs: undefined,
          colors: {},
          names: {},
        },
      );
      expect(JSON.parse(values.get("agent-collab-viewer.view:local:my-clone") ?? "{}")).toEqual({
        view: "chat",
        topic: null,
      });
      expect(values.get("agent-collab-viewer.identity:local:other")).toContain("bob-agent");
    });
  });

  it("without a snapshot, the failed folder stops being the one to return to and says why", async () => {
    const { memory, calls } = memoryWith({
      name: "my-clone",
      active: true,
      permission: "granted",
      unreadable: true,
    });
    const host = await render(memory);
    expect(host.querySelector("h1")?.textContent).toBe("Collab Viewer");
    expect(calls.marks).toContainEqual([false, "my-clone"]);
    expect(host.querySelector(".remembered-folder [role='alert']")?.textContent).toContain(
      "not a collaboration clone",
    );
  });

  it("keeps the message of a cancelled pick out of the remembered-folder section", async () => {
    const { memory } = memoryWith({ name: "my-clone", active: false, permission: "prompt" });
    const host = await render(memory, () =>
      Promise.reject(new DOMException("closed", "AbortError")),
    );
    await click(button(host, "Open local folder"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("No folder selected");
    expect(host.querySelector(".remembered-folder [role='alert']")).toBeNull();
    expect(button(host, "Reopen my-clone")).toBeDefined();
  });

  it("offers Reopen for a folder that was just picked, without a reload", async () => {
    const { memory, pick } = memoryWith(null);
    const host = await render(memory, () =>
      Promise.resolve({
        ...clone("fresh"),
        remember: () => {
          pick("fresh");
          return Promise.resolve();
        },
      }),
    );
    await click(button(host, "Open local folder"));
    await click(host.querySelector('button[aria-label="Settings"]') ?? undefined);
    expect(button(host, "Reopen fresh")).toBeDefined();
  });

  it("does not return to a remembered folder after a file-input folder was opened", async () => {
    const { memory, calls } = memoryWith({
      name: "my-clone",
      active: false,
      permission: "granted",
    });
    const host = await render(memory, null, undefined, {
      openLocalFileList: () => Promise.resolve(clone("from-files")),
    });
    await click(button(host, "Choose local folder from files"));
    const input = host.querySelector<HTMLInputElement>('input[type="file"][webkitdirectory]');
    const file = new File(["x"], "x.md");
    Object.defineProperty(file, "webkitRelativePath", { value: "from-files/x.md" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
      for (let round = 0; round < 4; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(host.querySelector("h1")?.textContent).toBe("Local folder: from-files");
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

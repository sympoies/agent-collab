// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Secret } from "../src/credentials/secret";
import { MemoryStore } from "../src/credentials/store";
import { FixtureSource } from "../src/source/fixture";
import { forgetStored } from "../src/settings/forget-stored";
import { SourceError, type MessageSource } from "../src/source/types";
import { Root } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { flat, MARKER, messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ID = "2026-10-01T0901-alice-agent-api-01";
const ENDPOINT = "https://api.github.com";
const SETTINGS = JSON.stringify({
  platform: "github",
  endpoint: ENDPOINT,
  repository: "alice-org/collab",
  branch: "",
  selfNames: [],
  credentialStorage: "memory",
});
const files = {
  ".agent-collab": `${MARKER}participants: alice-agent\n`,
  [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "In GitHub."),
};

describe("a reload reopens the last GitHub repository", () => {
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

  async function tokenStore(): Promise<MemoryStore> {
    const store = new MemoryStore();
    await store.set(
      "access-token",
      new Secret(JSON.stringify({ endpoint: ENDPOINT, token: "the-token" })),
    );
    return store;
  }

  async function mount(options: {
    storage: ReturnType<typeof storageMap>;
    credentials: MemoryStore;
    createSource?: (settings: unknown, token: Secret) => MessageSource;
    hosted?: boolean;
  }): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = root;
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <Root
            storage={options.storage}
            stores={{ memory: options.credentials, "browser-encrypted": new MemoryStore() }}
            createSource={options.createSource ?? (() => new FixtureSource(files))}
            createDemoSource={() => new FixtureSource(files)}
            createLiveDemoSource={() => new FixtureSource(files)}
            openLocalFolder={null}
            forgetStored={() => {
              forgetStored(options.storage);
            }}
            {...(options.hosted === true
              ? { createHostedSource: () => new FixtureSource({ ".agent-collab": MARKER }) }
              : {})}
          />
        </ThemeProvider>,
      );
      for (let round = 0; round < 6; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    return host;
  }

  const button = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

  async function click(element: Element | undefined): Promise<void> {
    expect(element).toBeDefined();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (let round = 0; round < 6; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }

  function unmount(): void {
    act(() => {
      mounted?.unmount();
    });
    document.body.replaceChildren();
  }

  it("opens the saved repository by itself after a reload, once it was the last viewer", async () => {
    const storage = storageMap({ "agent-collab-viewer.settings": SETTINGS });
    const credentials = await tokenStore();
    // The first visit: nothing is reopened, the reader opens the saved repository.
    let host = await mount({ storage, credentials });
    expect(host.querySelector("h1")?.textContent).toBe("Collab Viewer");
    await click(button(host, "Open saved repository"));
    expect(host.textContent).toContain("In GitHub.");
    expect(storage.values.get("agent-collab-viewer.last-source")).toBe("github");

    unmount();
    const createSource = vi.fn(() => new FixtureSource(files));
    host = await mount({ storage, credentials, createSource });
    expect(host.querySelector("h1")?.textContent).toBe("alice-org/collab");
    expect(host.textContent).toContain("In GitHub.");
    // The token goes to the source the same way as when the reader opens it by hand.
    expect(createSource).toHaveBeenCalledOnce();
  });

  it("does not reopen what the reader did not last use", async () => {
    const storage = storageMap({
      "agent-collab-viewer.settings": SETTINGS,
      "agent-collab-viewer.last-source": "other",
    });
    const host = await mount({ storage, credentials: await tokenStore() });
    expect(host.querySelector("h1")?.textContent).toBe("Collab Viewer");
    expect(button(host, "Open saved repository")).toBeDefined();
  });

  it("prefers the last GitHub repository to the served snapshot, and the snapshot otherwise", async () => {
    const storage = storageMap({
      "agent-collab-viewer.settings": SETTINGS,
      "agent-collab-viewer.last-source": "github",
    });
    const credentials = await tokenStore();
    let host = await mount({ storage, credentials, hosted: true });
    expect(host.querySelector("h1")?.textContent).toBe("alice-org/collab");

    unmount();
    storage.values.set("agent-collab-viewer.last-source", "other");
    host = await mount({ storage, credentials, hosted: true });
    expect(host.querySelector("h1")?.textContent).toBe("Collaboration snapshot");
    expect(storage.values.get("agent-collab-viewer.last-source")).toBe("other");
  });

  it("opens Settings, not a blank screen, when no token is stored for the saved repository", async () => {
    const storage = storageMap({
      "agent-collab-viewer.settings": SETTINGS,
      "agent-collab-viewer.last-source": "github",
    });
    const host = await mount({ storage, credentials: new MemoryStore() });
    expect(host.querySelector("#github-form")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("saved repository");
  });

  it("opens Settings with the usual error when the repository cannot be loaded", async () => {
    const storage = storageMap({
      "agent-collab-viewer.settings": SETTINGS,
      "agent-collab-viewer.last-source": "github",
    });
    const failing = new FixtureSource(files);
    failing.head = () => Promise.reject(new SourceError("unauthorized", ""));
    const host = await mount({
      storage,
      credentials: await tokenStore(),
      createSource: () => failing,
    });
    expect(host.querySelector("#github-form")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("token was rejected");
  });

  it("does not reopen anything after Forget", async () => {
    const storage = storageMap({
      "agent-collab-viewer.settings": SETTINGS,
      "agent-collab-viewer.last-source": "github",
    });
    const credentials = await tokenStore();
    let host = await mount({ storage, credentials });
    expect(host.querySelector("h1")?.textContent).toBe("alice-org/collab");
    await click(host.querySelector('button[aria-label="Settings"]') ?? undefined);
    await click(button(host, "Forget what this browser remembers"));
    await click(button(host, "Forget everything"));
    expect(storage.values.has("agent-collab-viewer.last-source")).toBe(false);

    unmount();
    host = await mount({ storage, credentials });
    expect(host.querySelector("h1")?.textContent).toBe("Collab Viewer");
    expect(host.querySelector("#github-form")).toBeNull();
  });

  it("keeps the demos out of storage", async () => {
    const storage = storageMap();
    const setItem = vi.spyOn(storage, "setItem");
    const host = await mount({ storage, credentials: new MemoryStore() });
    await click(button(host, "Open live demo"));
    expect(host.textContent).toContain("In GitHub.");
    expect(setItem).not.toHaveBeenCalled();
  });
});

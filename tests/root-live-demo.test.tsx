// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Secret } from "../src/credentials/secret";
import { MemoryStore } from "../src/credentials/store";
import { Root } from "../src/ui/Root";
import { ThemeProvider, ThemeToggle } from "../src/ui/ThemeProvider";
import type { MessageSource } from "../src/source/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Root live demo", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("opens the live source without reading or writing saved settings or credentials", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const memory = new MemoryStore();
    const encrypted = new MemoryStore();
    const memoryGet = vi.spyOn(memory, "get");
    const encryptedGet = vi.spyOn(encrypted, "get");
    const memorySet = vi.spyOn(memory, "set");
    const memoryDelete = vi.spyOn(memory, "delete");
    const encryptedSet = vi.spyOn(encrypted, "set");
    const encryptedDelete = vi.spyOn(encrypted, "delete");
    const source: MessageSource = {
      head: vi.fn(() => Promise.resolve({ revision: "demo-revision", validator: null })),
      listDirectory: vi.fn(() => Promise.resolve([])),
      readFile: vi.fn(() => Promise.resolve("")),
      rateLimit: () => null,
    };
    const createLiveDemoSource = vi.fn(() => source);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <Root
            storage={storage}
            stores={{ memory, "browser-encrypted": encrypted }}
            createSource={() => source}
            createDemoSource={() => source}
            createLiveDemoSource={createLiveDemoSource}
          />
        </ThemeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(memoryGet).not.toHaveBeenCalled();
    expect(encryptedGet).not.toHaveBeenCalled();

    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Open live demo",
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(createLiveDemoSource).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Live demo");
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(memoryGet).not.toHaveBeenCalled();
    expect(encryptedGet).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(memorySet).not.toHaveBeenCalled();
    expect(memoryDelete).not.toHaveBeenCalled();
    expect(encryptedSet).not.toHaveBeenCalled();
    expect(encryptedDelete).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("keeps a later live-demo choice when saved-repository loading is still pending", async () => {
    const values = new Map([
      [
        "agent-collab-viewer.settings",
        JSON.stringify({
          platform: "github",
          endpoint: "https://api.github.com",
          repository: "alice-org/collab",
          branch: "",
          selfNames: [],
          credentialStorage: "memory",
        }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn(),
    };
    const memory = new MemoryStore();
    const encrypted = new MemoryStore();
    let resolveCredential: (value: Secret | null) => void = () => undefined;
    const pendingCredential = new Promise<Secret | null>((resolve) => {
      resolveCredential = resolve;
    });
    const memoryGet = vi.spyOn(memory, "get").mockReturnValue(pendingCredential);
    const source: MessageSource = {
      head: vi.fn(() => Promise.resolve({ revision: "demo-revision", validator: null })),
      listDirectory: vi.fn(() => Promise.resolve([])),
      readFile: vi.fn(() => Promise.resolve("")),
      rateLimit: () => null,
    };
    const createSource = vi.fn(() => source);
    const createLiveDemoSource = vi.fn(() => source);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <Root
            storage={storage}
            stores={{ memory, "browser-encrypted": encrypted }}
            createSource={createSource}
            createDemoSource={() => source}
            createLiveDemoSource={createLiveDemoSource}
          />
        </ThemeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const saved = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Open saved repository",
    );
    expect(saved).toBeDefined();
    await act(async () => {
      saved?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(memoryGet).toHaveBeenCalledOnce();

    const live = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Open live demo",
    );
    expect(live).toBeDefined();
    await act(async () => {
      live?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Live demo");

    await act(async () => {
      resolveCredential(
        new Secret(
          JSON.stringify({ endpoint: "https://api.github.com", token: "test-token-not-real" }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createLiveDemoSource).toHaveBeenCalledOnce();
    expect(createSource).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Live demo");

    act(() => {
      root.unmount();
    });
  });
});

describe("ThemeProvider storage errors", () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.theme;
  });

  it("keeps the theme toggle usable when its injected storage throws", () => {
    document.documentElement.dataset.theme = "night-owl";
    const setItem = vi.fn(() => {
      throw new DOMException("Theme preference is read-only", "QuotaExceededError");
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const uncaught: string[] = [];
    const onError = (event: ErrorEvent) => {
      uncaught.push(event.message);
      event.preventDefault();
    };
    window.addEventListener("error", onError);

    try {
      act(() => {
        root.render(
          <ThemeProvider storage={{ getItem: () => null, setItem }}>
            <ThemeToggle />
          </ThemeProvider>,
        );
      });
      const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Use Paper theme"]');
      expect(toggle).not.toBeNull();
      act(() => {
        toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(setItem).toHaveBeenCalledWith("agent-collab-viewer.theme", "paper");
      expect(document.documentElement.dataset.theme).toBe("paper");
      expect(uncaught).toEqual([]);
    } finally {
      window.removeEventListener("error", onError);
      act(() => {
        root.unmount();
      });
    }
  });
});

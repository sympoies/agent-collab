// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../src/credentials/store";
import { Root } from "../src/ui/Root";
import type { MessageSource } from "../src/source/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Root live demo", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("opens the live source without writing settings or credentials", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const memory = new MemoryStore();
    const encrypted = new MemoryStore();
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
        <Root
          storage={storage}
          stores={{ memory, "browser-encrypted": encrypted }}
          createSource={() => source}
          createDemoSource={() => source}
          createLiveDemoSource={createLiveDemoSource}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

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
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(memorySet).not.toHaveBeenCalled();
    expect(memoryDelete).not.toHaveBeenCalled();
    expect(encryptedSet).not.toHaveBeenCalled();
    expect(encryptedDelete).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});

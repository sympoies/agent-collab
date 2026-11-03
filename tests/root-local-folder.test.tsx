// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../src/credentials/store";
import { FixtureSource } from "../src/source/fixture";
import { Root, type LocalFolderOpen } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { flat, MARKER, messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ID = "2026-10-01T0901-alice-agent-api-01";

function folder(
  when: () => Date | null,
  files: Record<string, string> = {
    ".agent-collab": MARKER,
    [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "From the local clone."),
  },
): FixtureSource {
  const source = new FixtureSource(files);
  Object.assign(source, { lastChanged: when });
  return source;
}

describe("Root with a local folder", () => {
  let mounted: { host: HTMLElement; root: ReactRoot } | null = null;

  afterEach(() => {
    if (mounted !== null) {
      const { root } = mounted;
      act(() => {
        root.unmount();
      });
    }
    mounted = null;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  async function render(
    openLocalFolder: (() => Promise<LocalFolderOpen>) | null,
    storage = { getItem: () => null, setItem: () => undefined },
  ): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
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
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("explains instead of showing a broken button when the browser has no folder picker", async () => {
    const host = await render(null);
    expect(button(host, "Open local folder")).toBeUndefined();
    expect(host.querySelector(".local-unsupported")?.textContent).toContain(
      "needs a browser that can open folders",
    );
  });

  it("shows a neutral message when no folder is chosen or the browser refuses one", async () => {
    const open = vi.fn(() => Promise.reject(new DOMException("private detail", "AbortError")));
    const host = await render(open);
    await click(button(host, "Open local folder"));
    expect(open).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "No folder selected, or the browser does not allow this folder.",
    );
    expect(host.textContent).not.toContain("private detail");
    expect(host.querySelector(".local-unsupported")).toBeNull();
  });

  it("refuses a folder that is not a collaboration clone and stays where it was", async () => {
    const open = () =>
      Promise.resolve({ source: folder(() => null, { "README.md": "hi" }), name: "other" });
    const host = await render(open);
    await click(button(host, "Open local folder"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "not a collaboration clone",
    );
    expect(host.querySelector("h1")?.textContent).toBe("Agent collaboration viewer");
  });

  it("opens the clone read-only, labels it experimental and shows when it last changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    const changed = new Date("2026-11-03T11:55:00Z");
    const open = () => Promise.resolve({ source: folder(() => changed), name: "my-clone" });
    const host = await render(open);
    await click(button(host, "Open local folder"));

    expect(host.querySelector("h1")?.textContent).toBe("Local folder: my-clone");
    expect(host.textContent).toContain("From the local clone.");
    const indicator = host.querySelector(".source-indicator");
    expect(indicator?.textContent).toContain("Local folder");
    expect(indicator?.textContent).toContain("experimental");
    const last = host.querySelector(".last-changed");
    expect(last?.textContent).toBe("Last change seen 5 minutes ago");
    expect(last?.getAttribute("title")).toContain(changed.toLocaleString());
    // Read-only: nothing in the page offers to write, and no identity is saved for the folder.
    expect(button(host, "Local folder")).toBeDefined();
  });

  it("updates the last-changed time when the clone changes and the viewer refreshes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    let changed = new Date("2026-11-03T11:00:00Z");
    const source = folder(() => changed);
    const host = await render(() => Promise.resolve({ source, name: "clone" }));
    await click(button(host, "Open local folder"));
    expect(host.querySelector(".last-changed")?.textContent).toBe("Last change seen 1 hour ago");

    const second = "2026-10-01T0902-bob-agent-api-01";
    source.commit({
      ".agent-collab": MARKER,
      [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "From the local clone."),
      [flat("2026-10", 1, 2)]: messageText(second, "bob-agent", "api", {}, "Added on disk."),
    });
    changed = new Date("2026-11-03T11:59:30Z");
    await click(button(host, "Refresh"));
    expect(host.textContent).toContain("Added on disk.");
    expect(host.querySelector(".last-changed")?.textContent).toBe("Last change seen just now");
  });

  it("offers to choose a folder again from the toolbar, and keeps the viewer on a refusal", async () => {
    const calls: number[] = [];
    const open = () => {
      calls.push(1);
      return calls.length === 1
        ? Promise.resolve({ source: folder(() => null), name: "first" })
        : Promise.reject(new DOMException("x", "AbortError"));
    };
    const host = await render(open);
    await click(button(host, "Open local folder"));
    expect(host.querySelector(".last-changed")?.textContent).toBe("No file changes seen yet");
    await click(button(host, "Local folder"));
    expect(calls).toHaveLength(2);
    expect(host.querySelector("h1")?.textContent).toBe("Local folder: first");
    expect(host.querySelector(".notice")?.textContent).toBe(
      "No folder selected, or the browser does not allow this folder.",
    );
  });

  it("has no folder button or source indicator on other sources", async () => {
    const host = await render(null);
    await click(button(host, "Open another repository"));
    await click(button(host, "Open offline demo"));
    expect(button(host, "Local folder")).toBeUndefined();
    expect(host.querySelector(".source-indicator")).toBeNull();
  });
});

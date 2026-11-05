// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { Toolbar } from "../src/ui/Toolbar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A controllable matchMedia: `setNarrow` flips the match and tells the listeners. */
function mockMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return matches;
    },
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
  };
  // Only the width query is controllable; other queries (the color scheme) never match or change.
  const other = {
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  window.matchMedia = vi.fn((text: string) =>
    text.includes("max-width") ? query : other,
  ) as unknown as typeof window.matchMedia;
  return {
    query,
    listeners,
    setNarrow: (value: boolean) => {
      matches = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("Toolbar", () => {
  let mounted: { host: HTMLElement; root: Root } | null = null;
  const original: Window["matchMedia"] | undefined = window.matchMedia.bind(window);
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };

  beforeEach(() => {
    store.clear();
    document.documentElement.lang = "";
  });
  afterEach(() => {
    if (mounted !== null) {
      const { root } = mounted;
      act(() => {
        root.unmount();
      });
    }
    mounted = null;
    document.body.replaceChildren();
    window.matchMedia = original;
  });

  async function render(
    options: { picker?: boolean; onFolder?: () => void } = {},
  ): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <LocaleProvider storage={storage}>
          <ThemeProvider storage={storage}>
            <Toolbar
              primary={<button type="button">primary</button>}
              identity={
                <button type="button" className="identity-button">
                  identity
                </button>
              }
              onPickLocalFolder={
                options.picker === false ? undefined : (options.onFolder ?? (() => undefined))
              }
              onOpenSettings={() => undefined}
            />
          </ThemeProvider>
        </LocaleProvider>,
      );
      await Promise.resolve();
    });
    return host;
  }
  const click = async (target: Element | null) => {
    await act(async () => {
      target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  };
  const openMenu = async (host: HTMLElement) => {
    await click(host.querySelector('[aria-haspopup="menu"]'));
    return host.querySelector('[role="menu"]');
  };
  const names = (host: HTMLElement) =>
    [...host.querySelectorAll("button, [role^=menuitem]")].map(
      (node) => node.getAttribute("aria-label") ?? node.textContent,
    );

  it("a wide screen shows every control and no menu", async () => {
    mockMatchMedia(false);
    const host = await render();
    expect(host.querySelector(".bar-actions")?.getAttribute("data-layout")).toBe("icons");
    expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(names(host)).toEqual(expect.arrayContaining(["identity", "Local folder", "Settings"]));
  });

  it("Local folder is absent in both layouts when the browser has no picker", async () => {
    const media = mockMatchMedia(false);
    const host = await render({ picker: false });
    expect(names(host)).not.toContain("Local folder");
    await act(async () => {
      media.setNarrow(true);
      await Promise.resolve();
    });
    await openMenu(host);
    expect(names(host).join("|")).not.toContain("Local folder");
    expect(host.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
  });

  it("the menu has no profile item: the identity button stays outside it", async () => {
    mockMatchMedia(true);
    const host = await render();
    expect(host.querySelector(".bar-actions > .identity-button")).not.toBeNull();
    await openMenu(host);
    expect(host.querySelector('[role="menuitemcheckbox"]')).toBeNull();
  });

  it("the language radios show the current locale and switch it", async () => {
    mockMatchMedia(true);
    const host = await render();
    await openMenu(host);
    const radios = () => [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(radios().map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    const ja = radios()[1];
    await click(ja ?? null);
    expect(document.documentElement.lang).toBe("ja");
    expect(store.get("agent-collab-viewer.locale")).toBe("ja");
    await openMenu(host);
    expect(radios().map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("the theme item names the theme it switches to and toggles it", async () => {
    mockMatchMedia(true);
    document.documentElement.dataset.theme = "night-owl";
    const host = await render();
    await openMenu(host);
    const theme = () =>
      [...host.querySelectorAll('[role="menuitem"]')].find((item) =>
        /theme/i.test(item.textContent),
      );
    expect(theme()?.textContent).toBe("Use Paper theme");
    await click(theme() ?? null);
    expect(document.documentElement.dataset.theme).toBe("paper");
    await openMenu(host);
    expect(theme()?.textContent).toBe("Use Night Owl theme");
  });

  it("choosing Local folder or Settings returns focus to the trigger", async () => {
    mockMatchMedia(true);
    const host = await render();
    for (const label of ["Local folder", "Settings"]) {
      await openMenu(host);
      const item = [...host.querySelectorAll('[role="menuitem"]')].find(
        (candidate) => candidate.textContent === label,
      );
      await click(item ?? null);
      expect(host.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(host.querySelector('[aria-haspopup="menu"]'));
    }
  });

  it("an action that moves focus elsewhere keeps it there", async () => {
    mockMatchMedia(true);
    const target = document.createElement("input");
    document.body.append(target);
    const host = await render({
      onFolder: () => {
        target.focus();
      },
    });
    await openMenu(host);
    await click(host.querySelector('[role="menuitem"]'));
    expect(document.activeElement).toBe(target);
  });

  it("crossing the width threshold with the menu open moves focus to the replacement control and cleans up", async () => {
    const media = mockMatchMedia(true);
    const host = await render();
    expect(media.listeners.size).toBeGreaterThan(0);
    await openMenu(host);
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    await act(async () => {
      media.setNarrow(false);
      await Promise.resolve();
    });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".identity-button"));

    // And back: the More trigger takes focus only if the menu had been open.
    await act(async () => {
      media.setNarrow(true);
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(host.querySelector(".identity-button"));
    await openMenu(host);
    await act(async () => {
      media.setNarrow(false);
      await Promise.resolve();
    });
    await act(async () => {
      media.setNarrow(true);
      await Promise.resolve();
    });
    // Closed menu, no focus theft on the way back.
    expect(document.activeElement).toBe(host.querySelector(".identity-button"));

    act(() => {
      mounted?.root.unmount();
    });
    mounted = null;
    expect(media.listeners.size).toBe(0);
    expect(media.query.removeEventListener).toHaveBeenCalled();
  });
});

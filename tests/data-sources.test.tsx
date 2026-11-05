// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { DataSources, ForgetSection, type DataSourcesProps } from "../src/ui/DataSources";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("DataSources", () => {
  let mounted: Root | null = null;
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

  function props(over: Partial<DataSourcesProps> = {}): DataSourcesProps {
    return {
      hosted: null,
      local: { pickFolder: null, pickFiles: null, message: null, remembered: null },
      onLiveDemo: () => undefined,
      onOfflineDemo: () => undefined,
      ...over,
    };
  }

  function mount(value: DataSourcesProps, children: ReactNode = null): HTMLElement {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = root;
    act(() => {
      root.render(
        <LocaleProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <DataSources {...value} />
          {children}
        </LocaleProvider>,
      );
    });
    return host;
  }

  const button = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

  async function click(element: Element | undefined): Promise<void> {
    expect(element).toBeDefined();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }

  it("lists every way to get data, each with its own action", async () => {
    const onLiveDemo = vi.fn();
    const onOfflineDemo = vi.fn();
    const hosted = vi.fn();
    const pickFolder = vi.fn();
    const host = mount(
      props({
        hosted,
        local: { pickFolder, pickFiles: null, message: null, remembered: null },
        onLiveDemo,
        onOfflineDemo,
      }),
    );
    expect([...host.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Snapshot served with this page",
      "GitHub repository",
      "Local folder",
      "Live demo",
      "Offline demo",
    ]);
    await click(button(host, "Open the snapshot"));
    await click(button(host, "Open local folder (experimental)"));
    await click(button(host, "Open live demo"));
    await click(button(host, "Open offline demo"));
    expect(hosted).toHaveBeenCalledOnce();
    expect(pickFolder).toHaveBeenCalledOnce();
    expect(onLiveDemo).toHaveBeenCalledOnce();
    expect(onOfflineDemo).toHaveBeenCalledOnce();
    // The GitHub row points at the connection form that follows.
    expect(host.querySelector('a[href="#github-form"]')?.textContent).toBe("Connect a repository");
  });

  it("leaves out the snapshot when the deployment serves none", () => {
    const host = mount(props());
    expect(host.textContent).not.toContain("Snapshot served with this page");
  });

  it("offers the file chooser, or says the browser cannot open folders", () => {
    const files = mount(
      props({
        local: { pickFolder: null, pickFiles: () => undefined, message: null, remembered: null },
      }),
    );
    expect(button(files, "Choose local folder from files")).toBeDefined();
    expect(files.querySelector(".local-unsupported")?.textContent).toContain(
      "Choose local folder from files",
    );
    act(() => {
      mounted?.unmount();
    });
    document.body.replaceChildren();
    const none = mount(props());
    expect(none.querySelector(".local-unsupported")).not.toBeNull();
    expect(button(none, "Open local folder (experimental)")).toBeUndefined();
  });

  it("shows why a folder failed and the remembered folder inside the local folder card", () => {
    const host = mount(
      props({
        local: {
          pickFolder: () => undefined,
          pickFiles: null,
          message: { key: "local.notClone" },
          remembered: <p className="remembered-marker">Remembered clone</p>,
        },
      }),
    );
    const card = host.querySelector('[data-source="local"]');
    expect(card?.querySelector('[role="alert"]')?.textContent).toContain(
      "not a collaboration clone",
    );
    expect(card?.querySelector(".remembered-marker")).not.toBeNull();
  });

  it("asks before forgetting, then forgets and says so", async () => {
    const onForget = vi.fn(() => Promise.resolve());
    const host = mount(props(), <ForgetSection onForget={onForget} />);
    await click(button(host, "Forget what this browser remembers"));
    expect(onForget).not.toHaveBeenCalled();
    expect(host.textContent).toContain("language and theme");

    await click(button(host, "Cancel"));
    expect(button(host, "Forget everything")).toBeUndefined();

    await click(button(host, "Forget what this browser remembers"));
    await click(button(host, "Forget everything"));
    expect(onForget).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "This browser no longer remembers anything but your language and theme.",
    );
  });

  it("says so when something could not be forgotten", async () => {
    const host = mount(props(), <ForgetSection onForget={() => Promise.reject(new Error("x"))} />);
    await click(button(host, "Forget what this browser remembers"));
    await click(button(host, "Forget everything"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be removed");
  });

  describe("focus in the confirm step", () => {
    const active = () => document.activeElement?.textContent;

    it("moves to Cancel, comes back to the trigger on Cancel and on Escape", async () => {
      const host = mount(props(), <ForgetSection onForget={() => Promise.resolve()} />);
      await click(button(host, "Forget what this browser remembers"));
      expect(active()).toBe("Cancel");

      await click(button(host, "Cancel"));
      expect(active()).toBe("Forget what this browser remembers");

      await click(button(host, "Forget what this browser remembers"));
      const group = host.querySelector('[role="group"]');
      await act(async () => {
        group?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await Promise.resolve();
      });
      expect(button(host, "Forget everything")).toBeUndefined();
      expect(active()).toBe("Forget what this browser remembers");
    });

    it("returns to the trigger after forgetting", async () => {
      const host = mount(props(), <ForgetSection onForget={() => Promise.resolve()} />);
      await click(button(host, "Forget what this browser remembers"));
      await click(button(host, "Forget everything"));
      expect(active()).toBe("Forget what this browser remembers");
    });
  });

  it("has no second heading above the source cards", () => {
    const host = mount(props());
    expect(host.querySelectorAll("h2")).toHaveLength(0);
    expect(host.querySelector(".data-sources")?.getAttribute("aria-label")).toBe("Data source");
  });
});

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../src/credentials/store";
import { FixtureSource } from "../src/source/fixture";
import {
  LanguageSwitcher,
  LOCALE_KEY,
  LocaleProvider,
  useLocale,
} from "../src/i18n/LocaleProvider";
import { Loader } from "../src/loader/loader";
import { App } from "../src/ui/App";
import { Root } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const throwing = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("LocaleProvider", () => {
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
    document.documentElement.removeAttribute("lang");
    vi.unstubAllGlobals();
  });

  function languages(...list: string[]) {
    vi.stubGlobal("navigator", { languages: list, language: list[0] ?? "en" });
  }

  async function render(
    storage: Parameters<typeof LocaleProvider>[0]["storage"],
  ): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <LocaleProvider storage={storage}>
          <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
            <Root
              storage={{ getItem: () => null, setItem: () => undefined }}
              stores={{ memory: new MemoryStore(), "browser-encrypted": new MemoryStore() }}
              createSource={() => new FixtureSource({})}
              createDemoSource={() => new FixtureSource({})}
              createLiveDemoSource={() => new FixtureSource({})}
              openLocalFolder={null}
            />
          </ThemeProvider>
        </LocaleProvider>,
      );
      await Promise.resolve();
    });
    return host;
  }

  const select = (host: HTMLElement) =>
    host.querySelector<HTMLSelectElement>(".language-switcher select");

  async function choose(host: HTMLElement, locale: string) {
    await act(async () => {
      const element = select(host);
      if (element !== null) element.value = locale;
      element?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  }

  it("follows the browser language by default and sets the page language", async () => {
    languages("ja-JP", "en");
    const host = await render(memoryStorage());
    expect(host.querySelector("h1")?.textContent).toBe("エージェント協調ビューア");
    expect(select(host)?.value).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
  });

  it("prefers the saved choice over the browser language", async () => {
    languages("ja");
    const host = await render(memoryStorage({ [LOCALE_KEY]: "zh-TW" }));
    expect(host.querySelector("h1")?.textContent).toBe("代理人協作檢視器");
    expect(document.documentElement.lang).toBe("zh-TW");
  });

  it("ignores a saved value that is not a supported language", async () => {
    languages("en");
    const host = await render(memoryStorage({ [LOCALE_KEY]: "fr" }));
    expect(host.querySelector("h1")?.textContent).toBe("Agent collaboration viewer");
  });

  it("switches language from the visible switcher and saves the choice", async () => {
    languages("en");
    const storage = memoryStorage();
    const host = await render(storage);
    expect([...(select(host)?.options ?? [])].map((option) => option.textContent)).toEqual([
      "English",
      "日本語",
      "繁體中文",
    ]);
    await choose(host, "ja");
    expect(host.querySelector("h1")?.textContent).toBe("エージェント協調ビューア");
    expect(storage.values.get(LOCALE_KEY)).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
    await choose(host, "en");
    expect(host.querySelector("h1")?.textContent).toBe("Agent collaboration viewer");
  });

  it("works when storage throws on read and on write", async () => {
    languages("zh-TW");
    const host = await render(throwing);
    expect(host.querySelector("h1")?.textContent).toBe("代理人協作檢視器");
    await choose(host, "ja");
    expect(host.querySelector("h1")?.textContent).toBe("エージェント協調ビューア");
  });

  it("formats dates with Intl in the chosen language", async () => {
    languages("en");
    let formatted = "";
    function Probe() {
      const { formatDateTime } = useLocale();
      formatted = formatDateTime(new Date("2026-11-03T08:05:00Z"));
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <LocaleProvider storage={memoryStorage({ [LOCALE_KEY]: "ja" })}>
          <Probe />
          <LanguageSwitcher />
        </LocaleProvider>,
      );
      await Promise.resolve();
    });
    expect(formatted).toBe(
      new Intl.DateTimeFormat("ja", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date("2026-11-03T08:05:00Z"),
      ),
    );
    expect(formatted).toContain("2026");
    expect(formatted).not.toMatch(/Nov/);
  });

  describe("a message already on screen when the language changes", () => {
    async function renderApp(notice: string | { key: "live.checked" }) {
      languages("en");
      const loader = new Loader(new FixtureSource({ ".agent-collab": "collab-protocol: 1\n" }));
      await loader.open();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      mounted = { host, root };
      await act(async () => {
        root.render(
          <LocaleProvider storage={memoryStorage()}>
            <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
              <App
                loader={loader}
                title="Repo"
                selfNames={new Set()}
                identity={{ storage: null, key: "test" }}
                notice={notice}
                onOpenSettings={() => undefined}
              />
            </ThemeProvider>
          </LocaleProvider>,
        );
        await Promise.resolve();
      });
      return host;
    }

    it("follows the new language when it is a catalog message, and keeps its language when it is already composed text", async () => {
      const keyed = await renderApp({ key: "live.checked" });
      expect(keyed.querySelector(".notice")?.textContent).toBe("Checked the live repository.");
      await choose(keyed, "ja");
      expect(keyed.querySelector(".notice")?.textContent).toBe(
        "ライブのリポジトリを確認しました。",
      );

      act(() => {
        mounted?.root.unmount();
      });
      document.body.replaceChildren();
      const composed = await renderApp("Already composed in English.");
      await choose(composed, "ja");
      // Documented limitation (docs/i18n.md): composed live-demo notices keep the language they
      // were made in until the next action replaces them.
      expect(composed.querySelector(".notice")?.textContent).toBe("Already composed in English.");
    });

    it("follows the new language for the refresh alert and the showing-live banner", async () => {
      languages("en");
      const loader = new Loader(new FixtureSource({ ".agent-collab": "collab-protocol: 1\n" }));
      await loader.open();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      mounted = { host, root };
      await act(async () => {
        root.render(
          <LocaleProvider storage={memoryStorage()}>
            <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
              <App
                loader={loader}
                title="Repo"
                selfNames={new Set()}
                identity={{ storage: null, key: "test" }}
                notice={{ key: "live.showingLive" }}
                pollIntervalMs={300_000}
                onOpenSettings={() => undefined}
              />
            </ThemeProvider>
          </LocaleProvider>,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const refresh = () =>
        [...host.querySelectorAll("button")].find(
          (button) => button.textContent === "Refresh" || button.textContent === "更新",
        );
      // The first manual refresh runs; the second inside the five-minute interval is refused.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await act(async () => {
          refresh()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        "The live demo refreshes every five minutes. Wait for the next check before refreshing again.",
      );
      expect(host.querySelector(".notice")?.textContent).toBe("Showing the live repository.");

      await choose(host, "ja");
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        "ライブデモは 5 分ごとに更新されます。次の確認まで待ってから更新してください。",
      );
      expect(host.querySelector(".notice")?.textContent).toBe(
        "ライブのリポジトリを表示しています。",
      );
    });
  });
});

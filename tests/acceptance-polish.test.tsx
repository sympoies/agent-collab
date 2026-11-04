// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { en } from "../src/i18n/catalog";
import { ja } from "../src/i18n/ja";
import { zhTW } from "../src/i18n/zh-TW";
import { SettingsView } from "../src/ui/SettingsView";
import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { DEFAULT_DRAFT } from "../src/settings/model";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("acceptance polish", () => {
  let mounted: { host: HTMLElement; root: Root } | null = null;
  afterEach(() => {
    if (mounted !== null) {
      const { root } = mounted;
      act(() => {
        root.unmount();
      });
    }
    mounted = null;
    document.body.replaceChildren();
  });

  async function mount(node: React.ReactNode): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(node);
      await Promise.resolve();
    });
    return host;
  }

  const settings = () => (
    <SettingsView
      initial={{ ...DEFAULT_DRAFT, repository: "" }}
      storedEndpoints={{ memory: null, "browser-encrypted": null }}
      onSave={() => Promise.resolve({ repository: "settings.error.repository" })}
      onRemoveCredentials={() => Promise.resolve()}
      onCancel={null}
      onOpenDemo={() => undefined}
      onOpenLiveDemo={() => undefined}
    />
  );

  it("names each settings field by its label alone and connects hints and errors", async () => {
    const host = await mount(settings());
    expect(host.querySelectorAll("h1")).toHaveLength(0);
    const field = (label: string) => {
      const node = [...host.querySelectorAll("label")].find((l) => l.textContent === label);
      expect(node, label).toBeDefined();
      return host.querySelector<HTMLInputElement>(`#${CSS.escape(node?.htmlFor ?? "none")}`);
    };
    const names = field(en["settings.myNames"]);
    const hint = host.querySelector(
      `#${CSS.escape(names?.getAttribute("aria-describedby") ?? "none")}`,
    );
    expect(hint?.textContent).toBe(en["settings.myNamesHint"]);
    expect(field(en["settings.repository"])?.hasAttribute("aria-invalid")).toBe(false);

    const form = host.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const repository = field(en["settings.repository"]);
    expect(repository?.getAttribute("aria-invalid")).toBe("true");
    const error = host.querySelector(
      `#${CSS.escape(repository?.getAttribute("aria-describedby") ?? "none")}`,
    );
    expect(error?.textContent).toBe(en["settings.error.repository"]);
    expect(error?.getAttribute("role")).toBe("alert");
  });

  it("message times are not tab stops and each message is a programmatic focus target", async () => {
    const id = "2026-10-01T0900-alice-agent-api-01";
    const loader = new Loader(
      new FixtureSource({
        ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n",
        [`inbox/${id}.md`]: messageText(id, "alice-agent", "api"),
      }),
    );
    await loader.open();
    const host = await mount(
      <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
        <App
          loader={loader}
          title="Repo"
          selfNames={new Set()}
          identity={{ storage: null, key: "test" }}
          notice={null}
          onOpenSettings={() => undefined}
        />
      </ThemeProvider>,
    );
    expect(host.querySelectorAll("time[tabindex]")).toHaveLength(0);
    expect(host.querySelector(`#msg-${id}`)?.getAttribute("tabindex")).toBe("-1");
  });

  it("applies the clear translation fixes", () => {
    expect(ja["live.nextCheck"].startsWith(" ")).toBe(false);
    expect(ja["bar.viewingAs"]).toBe("閲覧者");
    expect(ja["chat.needs"]).toBe("必要事項:");
    expect(ja["chat.issueCount"]).not.toMatch(/^問題/);
    for (const key of [
      "receipt.state.concluded",
      "questions.concluded",
      "receipt.concluded",
    ] as const) {
      expect(zhTW[key], key).not.toContain("結案");
    }
    expect(zhTW["settings.keep"]).toContain("儲存");
    expect(Object.values(zhTW).some((text) => text.includes("保存"))).toBe(false);
  });
});

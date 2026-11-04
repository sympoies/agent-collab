// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../src/credentials/store";
import { en } from "../src/i18n/catalog";
import { ja } from "../src/i18n/ja";
import { zhTW } from "../src/i18n/zh-TW";
import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { App } from "../src/ui/App";
import { Root } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const A = "2026-10-01T0900-alice-agent-api-01";
const B = "2026-10-01T0930-bob-agent-api-01";
const FILES = {
  ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n",
  [`inbox/${A}.md`]: messageText(
    A,
    "alice-agent",
    "api",
    { refs: `topics/api/notes.md, https://docs.example.com/guide, ${B}` },
    "See the notes.",
  ),
  [`inbox/${B}.md`]: messageText(B, "bob-agent", "api", { reply_to: A, type: "answer" }),
  "topics/api/notes.md": "# Notes\n",
};

describe("screens", () => {
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
    vi.unstubAllGlobals();
  });

  async function mount(node: React.ReactNode): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          {node}
        </ThemeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return host;
  }
  const press = async (host: HTMLElement, label: string, byAria = false) => {
    const target = [...host.querySelectorAll("button")].find(
      (candidate) =>
        (byAria ? candidate.getAttribute("aria-label") : candidate.textContent) === label,
    );
    expect(target, label).toBeDefined();
    await act(async () => {
      target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  it("has exactly one h1 on the welcome, settings, viewer and live demo screens", async () => {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: "2026-11-03T08:00:00.000Z",
      revision: "snapshot-tree",
      files: Object.entries(FILES)
        .filter(([path]) => !path.startsWith("topics/"))
        .map(([path, text]) => ({ path, text })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(snapshot), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    const fixture = new FixtureSource(FILES);
    const host = await mount(
      <Root
        storage={{ getItem: () => null, setItem: () => undefined }}
        stores={{ memory: new MemoryStore(), "browser-encrypted": new MemoryStore() }}
        createSource={() => fixture}
        createDemoSource={() => fixture}
        createLiveDemoSource={() => fixture}
        openLocalFolder={null}
      />,
    );
    const h1 = () => [...host.querySelectorAll("h1")].map((node) => node.textContent);
    expect(h1()).toEqual(["Collab Viewer"]);
    await press(host, "Open another repository");
    expect(h1()).toEqual(["Collab Viewer"]);
    await press(host, "Open offline demo");
    expect(host.querySelector(".workspace")).not.toBeNull();
    expect(h1()).toHaveLength(1);
    await press(host, "Settings", true);
    await press(host, "Open live demo");
    expect(host.textContent).toContain("Live demo");
    expect(h1()).toEqual(["Live demo"]);
  });

  it("every control inside a message stays keyboard focusable; the message and times are not tab stops", async () => {
    const loader = new Loader(new FixtureSource(FILES));
    await loader.open();
    const host = await mount(
      <App
        loader={loader}
        title="Repo"
        selfNames={new Set()}
        identity={{ storage: null, key: "t" }}
        notice={null}
        onOpenSettings={() => undefined}
      />,
    );
    const message = host.querySelector<HTMLElement>(`#msg-${A}`);
    expect(message).not.toBeNull();
    // The message is only a programmatic target.
    expect(message?.getAttribute("tabindex")).toBe("-1");
    expect(host.querySelectorAll("time[tabindex]")).toHaveLength(0);
    const controls = [
      ...(message?.querySelectorAll<HTMLElement>("a[href], button, summary") ?? []),
    ];
    // The attachment card, the external link and the message link.
    expect(controls.length).toBeGreaterThanOrEqual(3);
    for (const control of controls) {
      expect(control.getAttribute("tabindex"), control.outerHTML.slice(0, 60)).not.toBe("-1");
      control.focus();
      expect(document.activeElement, control.outerHTML.slice(0, 60)).toBe(control);
    }
  });

  it("uses one word for the viewer selector in every message that mentions it", () => {
    const word = { ja: "閲覧者", zhTW: "檢視身分" };
    const mentions = (Object.keys(en) as (keyof typeof en)[]).filter((key) =>
      /viewing as/i.test(en[key]),
    );
    expect(mentions.length).toBeGreaterThan(1);
    for (const key of mentions) {
      expect(ja[key], key).toContain(word.ja);
      expect(zhTW[key], key).toContain(word.zhTW);
    }
    expect(Object.values(ja).some((text) => text.includes("表示する人"))).toBe(false);
  });
});

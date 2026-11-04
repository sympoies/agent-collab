// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { PreferenceStorage } from "../src/identity/preferences";
import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MARKER = "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n";
const A = "2026-10-01T0900-alice-agent-api-01";
const B = "2026-10-01T0930-bob-agent-api-01";
const KEY = "github:https://api.github.com/alice-org/collab";

const files = {
  ".agent-collab": MARKER,
  [`inbox/${A}.md`]: messageText(A, "alice-agent", "api", { to: "bob-agent" }),
  [`inbox/${B}.md`]: messageText(B, "bob-agent", "api", { to: "alice-agent" }),
};

function memoryStorage(): PreferenceStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

const throwingStorage: PreferenceStorage = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("App identity controls", () => {
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

  async function render(
    storage: PreferenceStorage | null,
    ownNames: readonly string[] = ["alice-agent"],
  ): Promise<HTMLElement> {
    const loader = new Loader(new FixtureSource(files));
    await loader.open();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={loader}
            title="Repo"
            selfNames={new Set(ownNames)}
            identity={{ storage, key: KEY }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    return host;
  }

  const button = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent === label || candidate.getAttribute("aria-label") === label,
    );

  async function click(element: Element | undefined): Promise<void> {
    expect(element).toBeDefined();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function viewAs(host: HTMLElement, value: string): Promise<void> {
    const select = host.querySelector<HTMLSelectElement>(".viewing-as select");
    expect(select).not.toBeNull();
    await act(async () => {
      if (select !== null) select.value = value;
      select?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  }

  const youGroups = (host: HTMLElement) =>
    [...host.querySelectorAll('.group[data-own="true"] .sender')].map((node) => node.textContent);

  it("puts Refresh first in the toolbar", async () => {
    const host = await render(memoryStorage());
    expect(host.querySelector(".bar-actions button")?.getAttribute("aria-label")).toBe("Refresh");
  });

  it("marks the viewer's own messages and follows Viewing as, saving the choice per repository", async () => {
    const storage = memoryStorage();
    const host = await render(storage);
    expect(youGroups(host)).toEqual(["alice-agent"]);
    expect(host.querySelectorAll(".you")).toHaveLength(1);
    // The reply to alice is highlighted; her own message to bob is not.
    expect(
      [...host.querySelectorAll(".message")].map((node) => node.getAttribute("data-addressed")),
    ).toEqual(["false", "true"]);

    await viewAs(host, "bob-agent");
    expect(youGroups(host)).toEqual(["bob-agent"]);
    await viewAs(host, "");
    expect(youGroups(host)).toEqual([]);
    expect(host.querySelectorAll('[data-addressed="true"]')).toHaveLength(0);
    expect(
      JSON.parse(storage.values.get(`agent-collab-viewer.identity:${KEY}`) ?? "{}"),
    ).toMatchObject({ viewingAs: "" });

    // A new view of the same repository restores Observer even though own names say alice.
    act(() => {
      mounted?.root.unmount();
    });
    document.body.replaceChildren();
    const again = await render(storage);
    expect((again.querySelector(".viewing-as select") as HTMLSelectElement).value).toBe("");
    expect(youGroups(again)).toEqual([]);
  });

  it("lists the participants and Observer, and works when storage is missing or throws", async () => {
    const host = await render(throwingStorage);
    const options = [...host.querySelectorAll(".viewing-as option")].map(
      (node) => node.textContent,
    );
    expect(options).toEqual(["Observer", "alice-agent", "bob-agent"]);
    await viewAs(host, "bob-agent");
    expect(youGroups(host)).toEqual(["bob-agent"]);
    expect(host.querySelector(".error")).toBeNull();

    act(() => {
      mounted?.root.unmount();
    });
    document.body.replaceChildren();
    const inMemory = await render(null, []);
    expect(youGroups(inMemory)).toEqual([]);
    await viewAs(inMemory, "alice-agent");
    expect(youGroups(inMemory)).toEqual(["alice-agent"]);
  });

  it("changes a person's color and display name in Profile & colors, and Reset restores the defaults", async () => {
    const storage = memoryStorage();
    const host = await render(storage);
    const aliceSlot = () =>
      host.querySelector<HTMLElement>(".timeline .group")?.getAttribute("data-slot");
    expect(aliceSlot()).toBe("0");

    await click(button(host, "Profile & colors"));
    const swatch = [
      ...host.querySelectorAll<HTMLInputElement>('input[name="color-alice-agent"]'),
    ][4];
    expect(swatch?.getAttribute("aria-label")).toBe("Teal");
    await click(swatch);
    expect(aliceSlot()).toBe("4");

    const nameInput = host.querySelector<HTMLInputElement>('input[placeholder="alice-agent"]');
    await act(async () => {
      if (nameInput !== null) nameInput.value = "Alice";
      nameInput?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector(".timeline .sender")?.textContent).toBe("Alice");
    expect(host.querySelector(".timeline .sender")?.getAttribute("title")).toBe("alice-agent");
    expect(host.querySelector(".viewing-as option[value='alice-agent']")?.textContent).toBe(
      "Alice",
    );
    expect(storage.values.get(`agent-collab-viewer.identity:${KEY}`)).toContain('"Alice"');

    await click(button(host, "Reset colors and names"));
    expect(aliceSlot()).toBe("0");
    expect(host.querySelector(".timeline .sender")?.textContent).toBe("alice-agent");
    expect(storage.values.get(`agent-collab-viewer.identity:${KEY}`)).not.toContain("Alice");
  });

  it("keeps Viewing as options and sender labels unambiguous when display names collide", async () => {
    const storage = memoryStorage();
    storage.setItem(
      `agent-collab-viewer.identity:${KEY}`,
      JSON.stringify({ names: { "alice-agent": "Sam", "bob-agent": "Sam" } }),
    );
    const host = await render(storage);
    const options = [...host.querySelectorAll(".viewing-as option")].map(
      (node) => node.textContent,
    );
    expect(options).toEqual(["Observer", "Sam (alice-agent)", "Sam (bob-agent)"]);
    const senders = [...host.querySelectorAll(".timeline .sender")].map((node) => node.textContent);
    expect(senders).toEqual(["Sam (alice-agent)", "Sam (bob-agent)"]);
  });

  it("ignores a stored identity that is no longer a participant", async () => {
    const storage = memoryStorage();
    storage.setItem(
      `agent-collab-viewer.identity:${KEY}`,
      JSON.stringify({ viewingAs: "ghost-agent" }),
    );
    const stale = await render(storage, []);
    expect((stale.querySelector(".viewing-as select") as HTMLSelectElement).value).toBe("");
    expect(youGroups(stale)).toEqual([]);

    act(() => {
      mounted?.root.unmount();
    });
    document.body.replaceChildren();
    const withDefault = await render(storage, ["alice-agent"]);
    expect((withDefault.querySelector(".viewing-as select") as HTMLSelectElement).value).toBe(
      "alice-agent",
    );
  });

  it("shows an empty Profile & colors panel when the repository has no people yet", async () => {
    const loader = new Loader(new FixtureSource({ ".agent-collab": "collab-protocol: 1\n" }));
    await loader.open();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={loader}
            title="Repo"
            selfNames={new Set(["alice-agent"])}
            identity={{ storage: null, key: KEY }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    await click(button(host, "Profile & colors"));
    expect(host.querySelector(".profile")?.textContent).toContain("No people to show yet.");
    expect(
      [...host.querySelectorAll(".viewing-as option")].map((node) => node.textContent),
    ).toEqual(["Observer"]);
  });
});

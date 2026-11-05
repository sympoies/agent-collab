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

const KEY = "github:https://api.github.com/alice-org/collab";
const IDENTITY_KEY = `agent-collab-viewer.identity:${KEY}`;
const HINT_KEY = `agent-collab-viewer.identity-hint:${KEY}`;
const A = "2026-10-01T0900-alice-agent-api-01";
const B = "2026-10-01T0930-bob-agent-api-01";
const rosterFiles = {
  ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n",
  [`inbox/${A}.md`]: messageText(A, "alice-agent", "api", { to: "bob-agent" }),
  [`inbox/${B}.md`]: messageText(B, "bob-agent", "api", { to: "alice-agent" }),
};

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const storage: PreferenceStorage & { readonly values: Map<string, string> } = {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return storage;
}

describe("the identity button", () => {
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

  async function render(
    storage: PreferenceStorage | null,
    ownNames: readonly string[],
    files: Record<string, string> = rosterFiles,
    rosterKnown = true,
  ): Promise<HTMLElement> {
    const source = new FixtureSource(files);
    // A browser folder input that omits the marker cannot name the participants (#58).
    if (!rosterKnown) Object.assign(source, { participantsKnown: false });
    const loader = new Loader(source);
    await loader.open();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = root;
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
  async function click(element: Element | null): Promise<void> {
    expect(element).not.toBeNull();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }
  const identityButton = (host: HTMLElement) =>
    host.querySelector<HTMLButtonElement>(".bar-actions .identity-button");
  const hint = (host: HTMLElement) => host.querySelector(".identity-hint");

  it("replaces the labelled select and the profile button in the toolbar", async () => {
    const host = await render(memoryStorage(), ["alice-agent"]);
    expect(
      host.querySelector(".bar-actions select.viewing-as, .bar-actions .viewing-as"),
    ).toBeNull();
    expect(host.querySelector(".bar-actions [aria-label='Profile & colors']")).toBeNull();
    expect(host.querySelectorAll(".bar-actions .identity-button")).toHaveLength(1);
  });

  it("names the current identity: the default, a saved choice, Observer", async () => {
    let host = await render(memoryStorage(), ["alice-agent"]);
    expect(identityButton(host)?.getAttribute("aria-label")).toContain("alice-agent");
    expect(identityButton(host)?.textContent).toContain("alice-agent");

    act(() => mounted?.unmount());
    document.body.replaceChildren();
    host = await render(
      memoryStorage({ [IDENTITY_KEY]: JSON.stringify({ viewingAs: "bob-agent" }) }),
      ["alice-agent"],
    );
    expect(identityButton(host)?.getAttribute("aria-label")).toContain("bob-agent");

    act(() => mounted?.unmount());
    document.body.replaceChildren();
    host = await render(memoryStorage({ [IDENTITY_KEY]: JSON.stringify({ viewingAs: "" }) }), [
      "alice-agent",
    ]);
    expect(identityButton(host)?.getAttribute("aria-label")).toContain("Observer");
  });

  it("chooses who the viewer is in the panel, as the old select did", async () => {
    const storage = memoryStorage();
    const host = await render(storage, ["alice-agent"]);
    await click(identityButton(host));
    expect(identityButton(host)?.getAttribute("aria-expanded")).toBe("true");
    const select = host.querySelector<HTMLSelectElement>("#profile-panel .viewing-as select");
    expect(select?.value).toBe("alice-agent");
    expect([...(select?.options ?? [])].map((option) => option.value)).toEqual([
      "",
      "alice-agent",
      "bob-agent",
    ]);
    await act(async () => {
      if (select !== null) select.value = "bob-agent";
      select?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      [...host.querySelectorAll('.group[data-own="true"] .sender')].map((n) => n.textContent),
    ).toEqual(["bob-agent"]);
    expect(identityButton(host)?.textContent).toContain("bob-agent");
    expect(JSON.parse(storage.values.get(IDENTITY_KEY) ?? "{}")).toMatchObject({
      viewingAs: "bob-agent",
    });
  });

  it("shows the first-run hint once and keeps it dismissed", async () => {
    const storage = memoryStorage();
    let host = await render(storage, []);
    expect(hint(host)?.textContent).toContain("Choose who you are");
    await click(hint(host)?.querySelector("button") ?? null);
    expect(hint(host)).toBeNull();
    expect(storage.values.get(HINT_KEY)).toBe("1");

    act(() => mounted?.unmount());
    document.body.replaceChildren();
    host = await render(storage, []);
    expect(hint(host)).toBeNull();
  });

  it("shows no hint when a choice or a matching own name exists, or the roster is unknown", async () => {
    let host = await render(memoryStorage(), ["alice-agent"]);
    expect(hint(host)).toBeNull();
    act(() => mounted?.unmount());
    document.body.replaceChildren();
    host = await render(memoryStorage({ [IDENTITY_KEY]: JSON.stringify({ viewingAs: "" }) }), []);
    expect(hint(host)).toBeNull();
    act(() => mounted?.unmount());
    document.body.replaceChildren();
    host = await render(memoryStorage(), [], rosterFiles, false);
    expect(hint(host)).toBeNull();
    // The panel offers the senders seen in the loaded messages.
    await click(identityButton(host));
    expect(
      [...host.querySelectorAll("#profile-panel .viewing-as option")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Observer", "alice-agent", "bob-agent"]);
  });

  it("works without storage: the hint shows and dismisses for this view", async () => {
    const host = await render(null, []);
    expect(hint(host)).not.toBeNull();
    await click(hint(host)?.querySelector("button") ?? null);
    expect(hint(host)).toBeNull();
    await click(identityButton(host));
    expect(host.querySelector("#profile-panel")).not.toBeNull();
  });
});

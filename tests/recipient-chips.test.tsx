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
const TO_BOB = "2026-10-01T0900-alice-agent-api-01";
const TO_ALICE = "2026-10-01T0910-bob-agent-api-01";
const TO_ALL = "2026-10-01T0920-bob-agent-ops-01";
const TO_GHOST = "2026-10-01T0930-alice-agent-ops-01";
const REPLY = "2026-10-01T0915-alice-agent-api-02";
const ASK_BOB = "2026-10-01T0940-alice-agent-api-03";
const ASK_ALICE = "2026-10-01T0950-bob-agent-api-02";
const files = {
  ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n",
  [`inbox/${TO_BOB}.md`]: messageText(TO_BOB, "alice-agent", "api", { to: "bob-agent" }),
  [`inbox/${TO_ALICE}.md`]: messageText(TO_ALICE, "bob-agent", "api", { to: "alice-agent" }),
  // Alice replies to bob's message: the quote names bob, the parent's sender.
  [`inbox/${REPLY}.md`]: messageText(REPLY, "alice-agent", "api", {
    to: "bob-agent",
    reply_to: TO_ALICE,
  }),
  // A question to bob and one to alice (the viewer): their receipts list the recipient.
  [`inbox/${ASK_BOB}.md`]: messageText(ASK_BOB, "alice-agent", "api", {
    to: "bob-agent",
    type: "question",
    needs: "answer",
  }),
  [`inbox/${ASK_ALICE}.md`]: messageText(ASK_ALICE, "bob-agent", "api", {
    to: "alice-agent",
    type: "question",
    needs: "answer",
  }),
  [`inbox/${TO_ALL}.md`]: messageText(TO_ALL, "bob-agent", "ops", { to: "all" }),
  [`inbox/${TO_GHOST}.md`]: messageText(TO_GHOST, "alice-agent", "ops", { to: "ghost-agent" }),
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

describe("recipient chips, topic chips and avatar initials", () => {
  let root: Root | null = null;
  afterEach(() => {
    if (root !== null) {
      const mounted = root;
      act(() => {
        mounted.unmount();
      });
    }
    root = null;
    document.body.replaceChildren();
  });

  async function render(storage: PreferenceStorage = memoryStorage()): Promise<HTMLElement> {
    const loader = new Loader(new FixtureSource(files));
    await loader.open();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const mounted = root;
    await act(async () => {
      mounted.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={loader}
            title="Repo"
            selfNames={new Set(["alice-agent"])}
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
  async function click(element: Element | null | undefined): Promise<void> {
    expect(element).toBeTruthy();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }
  const topicButton = (host: HTMLElement, name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>(".topics button")].find((button) =>
      button.textContent.replace(/^#/, "").startsWith(name),
    );
  const chipFor = (host: HTMLElement, id: string) =>
    host.querySelector<HTMLElement>(`#msg-${id} .meta .recipient`);

  it("colors each recipient like the sender and emphasizes the viewer", async () => {
    const host = await render();
    // alice is the first person (slot 0), bob the second (slot 1).
    expect(chipFor(host, TO_BOB)?.getAttribute("data-slot")).toBe("1");
    expect(chipFor(host, TO_BOB)?.getAttribute("data-self")).toBeNull();
    expect(chipFor(host, TO_ALICE)?.getAttribute("data-slot")).toBe("0");
    expect(chipFor(host, TO_ALICE)?.getAttribute("data-self")).toBe("true");
  });

  it("colors the quoted sender like that person, not like the replier", async () => {
    const host = await render();
    // The replier is alice (slot 0); the quote names bob (slot 1).
    const from = host.querySelector(`#msg-${REPLY} .quote-from`);
    expect(from?.textContent).toBe("bob-agent");
    expect(from?.getAttribute("data-slot")).toBe("1");
  });

  it("lists each receipt recipient as a person chip, filled for the viewer", async () => {
    const host = await render();
    const chip = (id: string) => host.querySelector<HTMLElement>(`#msg-${id} .receipts .recipient`);
    expect(chip(ASK_BOB)?.getAttribute("data-kind")).toBe("person");
    expect(chip(ASK_BOB)?.getAttribute("data-slot")).toBe("1");
    expect(chip(ASK_BOB)?.getAttribute("data-self")).toBeNull();
    // The viewer is alice: the question to her marks her chip.
    expect(chip(ASK_ALICE)?.getAttribute("data-slot")).toBe("0");
    expect(chip(ASK_ALICE)?.getAttribute("data-self")).toBe("true");
  });

  it("keeps everyone and unknown recipients neutral, never emphasized", async () => {
    const host = await render();
    const everyone = chipFor(host, TO_ALL);
    expect(everyone?.getAttribute("data-kind")).toBe("everyone");
    expect(everyone?.textContent).toBe("everyone");
    const ghost = chipFor(host, TO_GHOST);
    expect(ghost?.getAttribute("data-kind")).toBe("unknown");
    expect(ghost?.textContent).toBe("ghost-agent");
    for (const chip of [everyone, ghost]) {
      expect(chip?.hasAttribute("data-slot")).toBe(false);
      expect(chip?.hasAttribute("data-self")).toBe(false);
    }
  });

  it("follows a color changed in the profile panel", async () => {
    const host = await render();
    await click(host.querySelector(".bar-actions .identity-button"));
    const swatch = host.querySelectorAll<HTMLInputElement>('input[name="color-bob-agent"]')[4];
    await click(swatch);
    expect(chipFor(host, TO_BOB)?.getAttribute("data-slot")).toBe("4");
  });

  it("shows one neutral topic chip in All and none inside a single topic", async () => {
    const host = await render();
    expect(host.querySelectorAll(".group .topic").length).toBeGreaterThan(0);
    await click(topicButton(host, "api"));
    expect(host.querySelectorAll(".group .topic")).toHaveLength(0);
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "All"));
    expect(host.querySelectorAll(".group .topic").length).toBeGreaterThan(0);
  });

  it("builds avatar initials from the display name, and from the id without one", async () => {
    const host = await render();
    const avatar = () =>
      host.querySelector(`#msg-${TO_BOB}`)?.closest(".group")?.querySelector(".avatar");
    expect(avatar()?.textContent).toBe("AA");
    await click(host.querySelector(".bar-actions .identity-button"));
    const input = host.querySelector<HTMLInputElement>('input[placeholder="alice-agent"]');
    await act(async () => {
      if (input !== null) input.value = "Alice Smith";
      input?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(avatar()?.textContent).toBe("AS");
    await act(async () => {
      if (input !== null) input.value = "小明";
      input?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(avatar()?.textContent).toBe("小");
  });
});

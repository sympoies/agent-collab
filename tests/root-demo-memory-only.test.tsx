// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../src/credentials/store";
import { FixtureSource } from "../src/source/fixture";
import { Root } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { flat, MARKER, messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ID = "2026-10-01T0901-alice-agent-api-01";
const files = {
  ".agent-collab": `${MARKER}participants: alice-agent, bob-agent\n`,
  [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "In the demo."),
};

describe("the demos keep the reader's choices in memory only", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  async function openDemo(via: "live" | "offline") {
    const storage = { getItem: vi.fn((): string | null => null), setItem: vi.fn() };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <Root
            storage={storage}
            stores={{ memory: new MemoryStore(), "browser-encrypted": new MemoryStore() }}
            createSource={() => new FixtureSource({})}
            createDemoSource={() => new FixtureSource(files)}
            createLiveDemoSource={() => new FixtureSource(files)}
            openLocalFolder={null}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    const press = async (label: string) => {
      const target = [...host.querySelectorAll("button")].find(
        (button) =>
          button.textContent === label ||
          button.textContent.startsWith(label) ||
          button.getAttribute("aria-label") === label,
      );
      expect(target, label).toBeDefined();
      await act(async () => {
        target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        for (let round = 0; round < 4; round += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
    };
    if (via === "live") await press("Open live demo");
    else {
      await press("Open another repository");
      await press("Open offline demo");
    }
    return { host, storage, press, root };
  }

  for (const via of ["live", "offline"] as const) {
    it(`writes and reads nothing when the person and the view change in the ${via} demo`, async () => {
      const { host, storage, press, root } = await openDemo(via);
      expect(host.textContent).toContain("In the demo.");
      const reads = storage.getItem.mock.calls.length;
      const select = host.querySelector<HTMLSelectElement>(".viewing-as select");
      expect(select).not.toBeNull();
      act(() => {
        if (select === null) return;
        select.value = "bob-agent";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await press("Files");
      expect(host.querySelector("#conversation-heading")?.textContent).toBe("Files");
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.getItem.mock.calls.length).toBe(reads);
      act(() => {
        root.unmount();
      });
    });
  }
});

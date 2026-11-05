// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Secret } from "../src/credentials/secret";
import { MemoryStore } from "../src/credentials/store";
import { FixtureSource } from "../src/source/fixture";
import { Root } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { flat, MARKER, messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ID = "2026-10-01T0901-alice-agent-api-01";
const ENDPOINT = "https://api.github.com";

describe("a GitHub repository opened through Root", () => {
  let mounted: ReactRoot | null = null;
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

  async function openSaved(
    storage: { getItem(key: string): string | null; setItem(key: string, value: string): void },
    memory: MemoryStore,
  ): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = root;
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <Root
            storage={storage}
            stores={{ memory, "browser-encrypted": new MemoryStore() }}
            createSource={() =>
              new FixtureSource({
                ".agent-collab": `${MARKER}participants: alice-agent\n`,
                [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "In GitHub."),
              })
            }
            createDemoSource={() => new FixtureSource({})}
            createLiveDemoSource={() => new FixtureSource({})}
            openLocalFolder={null}
          />
        </ThemeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const saved = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Open saved repository",
    );
    await act(async () => {
      saved?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      for (let round = 0; round < 4; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    return host;
  }

  it("restores no view and writes no view key", async () => {
    const values = new Map<string, string>([
      [
        "agent-collab-viewer.settings",
        JSON.stringify({
          platform: "github",
          endpoint: ENDPOINT,
          repository: "alice-org/collab",
          branch: "",
          selfNames: [],
          credentialStorage: "memory",
        }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const memory = new MemoryStore();
    await memory.set(
      "access-token",
      new Secret(JSON.stringify({ endpoint: ENDPOINT, token: "t" })),
    );

    let host = await openSaved(storage, memory);
    expect(host.textContent).toContain("In GitHub.");
    const files = [...host.querySelectorAll("button")].find((b) => b.textContent === "Files");
    await act(async () => {
      files?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector("#conversation-heading")?.textContent).toBe("Files");

    act(() => {
      mounted?.unmount();
    });
    document.body.replaceChildren();
    host = await openSaved(storage, memory);
    expect(host.querySelector("#conversation-heading")?.textContent).toBe("All conversations");
    expect([...values.keys()].filter((key) => key.includes(".view:"))).toEqual([]);
  });
});

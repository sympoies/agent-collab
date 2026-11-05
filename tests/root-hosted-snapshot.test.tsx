// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../src/credentials/store";
import { FixtureSource } from "../src/source/fixture";
import { SourceError, type MessageSource } from "../src/source/types";
import { Root } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { flat, MARKER, messageText } from "./support";

const TOPIC_MARKER =
  "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n";
const TOPIC_IDS = {
  api: "2026-10-01T0900-alice-agent-api-01",
  ops: "2026-10-01T1000-bob-agent-ops-01",
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ID = "2026-10-01T0901-alice-agent-api-01";
const NOW = new Date("2026-11-04T12:00:00Z");

interface Controls {
  generated: Date;
  checked: Date;
  failing: boolean;
}

function hosted(controls: Controls): MessageSource {
  const source = new FixtureSource({
    ".agent-collab": MARKER,
    [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "From the snapshot."),
  });
  const head = source.head.bind(source);
  return Object.assign(source, {
    head: (previous: Parameters<typeof head>[0]) =>
      controls.failing ? Promise.reject(new SourceError("unreachable", "")) : head(previous),
    snapshotTime: () => controls.generated,
    checkedAt: () => controls.checked,
  });
}

describe("Root with a served snapshot", () => {
  let mounted: { root: ReactRoot } | null = null;

  afterEach(() => {
    if (mounted !== null) {
      const { root } = mounted;
      act(() => {
        root.unmount();
      });
    }
    mounted = null;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  async function render(createHostedSource: () => MessageSource): Promise<HTMLElement> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const storage = { getItem: () => null, setItem: () => undefined };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { root };
    await act(async () => {
      root.render(
        <ThemeProvider storage={storage}>
          <Root
            storage={storage}
            stores={{ memory: new MemoryStore(), "browser-encrypted": new MemoryStore() }}
            createSource={() => new FixtureSource({})}
            createDemoSource={() => new FixtureSource({})}
            createLiveDemoSource={() => new FixtureSource({})}
            openLocalFolder={null}
            createHostedSource={createHostedSource}
          />
        </ThemeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return host;
  }

  const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

  it("shows when the snapshot was updated and says nothing while it is recent", async () => {
    const host = await render(() =>
      hosted({ generated: minutesAgo(3), checked: minutesAgo(0), failing: false }),
    );
    expect(host.textContent).toContain("From the snapshot.");
    expect(host.querySelector(".last-changed")?.textContent).toBe("Snapshot updated 3 minutes ago");
    expect(host.querySelector(".snapshot-warning")).toBeNull();
  });

  it("warns when the newest snapshot is older than ten minutes", async () => {
    const host = await render(() =>
      hosted({ generated: minutesAgo(15), checked: minutesAgo(0), failing: false }),
    );
    expect(host.querySelector(".snapshot-warning")?.textContent).toBe("May be out of date");
  });

  it("keeps the data and shows the last successful check when a fetch fails", async () => {
    const controls: Controls = { generated: minutesAgo(1), checked: minutesAgo(2), failing: false };
    const host = await render(() => hosted(controls));
    controls.failing = true;
    const refresh = host.querySelector('button[aria-label="Refresh"]');
    await act(async () => {
      refresh?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("From the snapshot.");
    expect(host.querySelector(".snapshot-warning")?.textContent).toBe(
      "Last successful check 2 minutes ago",
    );
  });

  it("stays on the welcome screen with a reason when the snapshot cannot be read", async () => {
    const host = await render(() => hosted({ generated: NOW, checked: NOW, failing: true }));
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be read");
    expect(host.textContent).toContain("Open the snapshot");
  });

  describe("choices kept across a reload", () => {
    const topicSnapshot = () =>
      new FixtureSource({
        ".agent-collab": TOPIC_MARKER,
        [`topics/api/inbox/2026-10/${TOPIC_IDS.api}.md`]: messageText(
          TOPIC_IDS.api,
          "alice-agent",
          "api",
          {},
          "In the api topic.",
        ),
        [`topics/ops/inbox/2026-10/${TOPIC_IDS.ops}.md`]: messageText(
          TOPIC_IDS.ops,
          "bob-agent",
          "ops",
          {},
          "In the ops topic.",
        ),
      });

    function memoryStorage() {
      const values = new Map<string, string>();
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
        values,
      };
    }

    async function open(storage: ReturnType<typeof memoryStorage>): Promise<HTMLElement> {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      mounted = { root };
      await act(async () => {
        root.render(
          <ThemeProvider storage={storage}>
            <Root
              storage={storage}
              stores={{ memory: new MemoryStore(), "browser-encrypted": new MemoryStore() }}
              createSource={() => new FixtureSource({})}
              createDemoSource={() => new FixtureSource({})}
              createLiveDemoSource={() => new FixtureSource({})}
              openLocalFolder={null}
              createHostedSource={topicSnapshot}
            />
          </ThemeProvider>,
        );
        for (let round = 0; round < 6; round += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
      return host;
    }

    async function reload(storage: ReturnType<typeof memoryStorage>): Promise<HTMLElement> {
      const previous = mounted;
      mounted = null;
      if (previous !== null) {
        act(() => {
          previous.root.unmount();
        });
      }
      document.body.replaceChildren();
      return open(storage);
    }

    async function click(element: Element): Promise<void> {
      await act(async () => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const topicButton = (host: HTMLElement, name: string) =>
      [...host.querySelectorAll<HTMLButtonElement>(".topics button")].find((button) =>
        button.textContent.replace(/^#/, "").startsWith(name),
      ) as HTMLButtonElement;

    it("returns to the chosen person and topic after a reload", async () => {
      const storage = memoryStorage();
      let host = await open(storage);
      await click(topicButton(host, "ops"));
      const select = host.querySelector<HTMLSelectElement>(
        ".viewing-as select",
      ) as HTMLSelectElement;
      act(() => {
        select.value = "bob-agent";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });

      host = await reload(storage);
      expect(host.querySelector<HTMLSelectElement>(".viewing-as select")?.value).toBe("bob-agent");
      expect(host.querySelector("h2.topic-heading")?.textContent).toMatch(/^#?ops$/);
      expect(topicButton(host, "ops").getAttribute("aria-pressed")).toBe("true");
      expect(host.textContent).toContain("In the ops topic.");
      expect(host.textContent).not.toContain("In the api topic.");
    });

    it("scopes the saved choices to the deployment's origin and base path", async () => {
      const storage = memoryStorage();
      const host = await open(storage);
      await click(topicButton(host, "ops"));
      const keys = [...storage.values.keys()].filter((key) => key.includes("hosted:"));
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key.endsWith(`hosted:${window.location.origin}${import.meta.env.BASE_URL}`)).toBe(
          true,
        );
      }
    });

    it("returns to the Files view after a reload", async () => {
      const storage = memoryStorage();
      let host = await open(storage);
      await click(topicButton(host, "Files"));
      host = await reload(storage);
      expect(host.querySelector("#conversation-heading")?.textContent).toBe("Files");
      expect(topicButton(host, "Files").getAttribute("aria-pressed")).toBe("true");
    });

    it("ignores a saved topic that is gone and keeps the saved view", async () => {
      const storage = memoryStorage();
      storage.values.set(
        [...storage.values.keys()].find((key) => key.includes(".view:")) ??
          `agent-collab-viewer.view:hosted:${window.location.origin}${import.meta.env.BASE_URL}`,
        JSON.stringify({ view: "files", topic: "removed" }),
      );
      const host = await open(storage);
      expect(host.querySelector("#conversation-heading")?.textContent).toBe("Files");
    });

    it("keeps nothing for a hosted snapshot when storage rejects writes", async () => {
      const storage = memoryStorage();
      storage.setItem = () => {
        throw new Error("blocked");
      };
      const host = await open(storage);
      await click(topicButton(host, "ops"));
      expect(host.querySelector("h2.topic-heading")?.textContent).toMatch(/^#?ops$/);
    });
  });
});

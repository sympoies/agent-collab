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
});

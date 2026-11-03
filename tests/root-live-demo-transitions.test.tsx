// @vitest-environment happy-dom

// Navigation and fallback transitions of the public live demo (docs/design.md, section 6).

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../src/credentials/store";
import { FixtureSource } from "../src/source/fixture";
import { SourceError, type MessageSource } from "../src/source/types";
import { Root } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MARKER = "collab-protocol: 1\nparticipants: alice-agent\n";
const OLDER = "2026-11-03T0900-alice-agent-api-01";
const NEWER = "2026-11-03T1000-alice-agent-api-01";
const MINUTE = 60_000;

function repoFiles(...messages: readonly (readonly [string, string])[]): Record<string, string> {
  const files: Record<string, string> = { ".agent-collab": MARKER };
  for (const [id, body] of messages) {
    files[`inbox/${id}.md`] = messageText(id, "alice-agent", "api", {}, body);
  }
  return files;
}

const snapshotFiles = repoFiles([OLDER, "Snapshot message."]);
const liveFiles = repoFiles([OLDER, "Snapshot message."], [NEWER, "Newer live message."]);

function rateLimited(retryAt: Date | null): MessageSource {
  const source = new FixtureSource({});
  vi.spyOn(source, "head").mockRejectedValue(new SourceError("rate-limited", "", 403, retryAt));
  return source;
}

interface Mounted {
  readonly host: HTMLElement;
  readonly root: ReactRoot;
}

describe("live demo transitions", () => {
  let mounted: Mounted | null = null;
  let snapshotRequests: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T09:00:00.000Z"));
  });

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
    vi.useRealTimers();
  });

  async function start(
    snapshot: Record<string, string> | null,
    createLiveDemoSource: () => MessageSource,
  ): Promise<HTMLElement> {
    snapshotRequests = vi.fn(() =>
      Promise.resolve(
        snapshot === null
          ? new Response("", { status: 404 })
          : new Response(
              JSON.stringify({
                schemaVersion: 1,
                generatedAt: "2026-11-03T08:00:00.000Z",
                revision: "snapshot-tree",
                files: Object.entries(snapshot).map(([path, text]) => ({ path, text })),
              }),
              { status: 200 },
            ),
      ),
    );
    vi.stubGlobal("fetch", snapshotRequests);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    const storage = { getItem: () => null, setItem: () => undefined };
    await act(async () => {
      root.render(
        <ThemeProvider storage={storage}>
          <Root
            storage={storage}
            stores={{ memory: new MemoryStore(), "browser-encrypted": new MemoryStore() }}
            createSource={() => new FixtureSource({})}
            createDemoSource={() => new FixtureSource({})}
            createLiveDemoSource={createLiveDemoSource}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    await click(host, "Open live demo");
    return host;
  }

  async function click(host: HTMLElement, label: string): Promise<void> {
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    );
    expect(button, `button "${label}"`).toBeDefined();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const hasButton = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll("button")].some((button) => button.textContent === label);

  it("replaces an older snapshot with the live repository once, without re-reading the snapshot", async () => {
    const createLiveDemoSource = vi.fn(() => new FixtureSource(liveFiles));
    const host = await start(snapshotFiles, createLiveDemoSource);
    expect(host.textContent).toContain("Snapshot message.");
    expect(host.textContent).not.toContain("Newer live message.");
    expect(createLiveDemoSource).not.toHaveBeenCalled();

    await click(host, "Check live now");
    expect(host.textContent).toContain("Newer live message.");
    expect(host.textContent).toContain("Snapshot message.");
    expect(hasButton(host, "Check live now")).toBe(false);
    expect(hasButton(host, "Refresh")).toBe(true);
    expect(createLiveDemoSource).toHaveBeenCalledOnce();
    expect(snapshotRequests).toHaveBeenCalledOnce();
  });

  it("keeps the snapshot through a rate limit, makes no request until the reset, then recovers", async () => {
    const resetAt = new Date(Date.now() + 30 * MINUTE);
    const createLiveDemoSource = vi
      .fn<() => MessageSource>()
      .mockReturnValueOnce(rateLimited(resetAt))
      .mockReturnValue(new FixtureSource(liveFiles));
    const host = await start(snapshotFiles, createLiveDemoSource);

    await click(host, "Check live now");
    expect(host.textContent).toContain("Snapshot message.");
    expect(host.querySelector(".notice")?.textContent).toContain("hit GitHub's API limit");

    // Repeated clicks before the reset reach no API source and keep the same data.
    vi.setSystemTime(Date.now() + 10 * MINUTE);
    await click(host, "Check live now");
    await click(host, "Check live now");
    expect(createLiveDemoSource).toHaveBeenCalledOnce();
    expect(host.querySelector(".notice")?.textContent).toContain("paused");
    expect(host.textContent).toContain("Snapshot message.");
    expect(host.textContent).not.toContain("Newer live message.");

    vi.setSystemTime(resetAt.getTime() + MINUTE);
    await click(host, "Check live now");
    expect(createLiveDemoSource).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Newer live message.");
  });

  it("falls back to the bundled sample when the live API is unavailable at first load, and does not retry on navigation", async () => {
    const createLiveDemoSource = vi.fn(() => rateLimited(new Date(Date.now() + 30 * MINUTE)));
    const host = await start(null, createLiveDemoSource);
    expect(host.querySelector(".notice")?.textContent).toContain(
      "Still showing the bundled sample",
    );
    expect(createLiveDemoSource).toHaveBeenCalledOnce();

    await click(host, "Settings");
    await click(host, "Open live demo");
    expect(host.querySelector(".notice")?.textContent).toContain("paused");
    await click(host, "Check live now");
    expect(createLiveDemoSource).toHaveBeenCalledOnce();
  });

  it("never returns to the older snapshot after the live repository was shown", async () => {
    const createLiveDemoSource = vi.fn(() => new FixtureSource(liveFiles));
    const host = await start(snapshotFiles, createLiveDemoSource);
    await click(host, "Check live now");

    await click(host, "Settings");
    await click(host, "Cancel");
    expect(host.textContent).toContain("Newer live message.");

    await click(host, "Settings");
    await click(host, "Open live demo");
    expect(host.textContent).toContain("Newer live message.");
    expect(hasButton(host, "Check live now")).toBe(false);
    expect(createLiveDemoSource).toHaveBeenCalledOnce();
    expect(snapshotRequests).toHaveBeenCalledOnce();
  });

  it("drops a live result that arrives after the user left the viewer, and shows it when they return", async () => {
    let release: () => void = () => undefined;
    const live = new FixtureSource(liveFiles);
    const head = live.head.bind(live);
    vi.spyOn(live, "head").mockImplementation(async (previous) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return head(previous);
    });
    const createLiveDemoSource = vi.fn<() => MessageSource>(() => live);
    const host = await start(snapshotFiles, createLiveDemoSource);

    await click(host, "Check live now");
    await click(host, "Settings");
    expect(hasButton(host, "Cancel")).toBe(true);
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Still on the settings screen: the late result did not replace it.
    expect(hasButton(host, "Cancel")).toBe(true);
    expect(host.textContent).not.toContain("Newer live message.");

    await click(host, "Cancel");
    expect(host.textContent).toContain("Newer live message.");
    expect(createLiveDemoSource).toHaveBeenCalledOnce();
  });
});

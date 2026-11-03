// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Loader } from "../src/loader/loader";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { SourceError, type DirectoryEntry, type MessageSource } from "../src/source/types";
import { flat, MARKER, messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOW = new Date("2026-11-02T00:00:00Z");
const MINUTE = 60_000;

describe("App rate-limit recovery for older messages", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("keeps the timeline and retries Load older only after the reset", async () => {
    vi.useFakeTimers({ now: NOW });
    const paths = [flat("2026-10", 1, 1), flat("2026-10", 2, 2)];
    const entries: DirectoryEntry[] = paths.map((path, index) => ({
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      kind: "file",
      objectId: `blob-${index + 1}`,
    }));
    const secondReads = vi.fn();
    let firstHead = true;
    const head = vi.fn(() => {
      if (firstHead) {
        firstHead = false;
        return Promise.resolve({ revision: "r1", validator: '"e1"' } as const);
      }
      return Promise.resolve("not-modified" as const);
    });
    const source: MessageSource = {
      head,
      listDirectory: vi.fn((_revision: string, path: string) => {
        if (path === "") {
          return Promise.resolve([
            { name: ".agent-collab", path: ".agent-collab", kind: "file", objectId: "marker" },
            { name: "inbox", path: "inbox", kind: "directory", objectId: "inbox" },
          ] satisfies DirectoryEntry[]);
        }
        if (path === "inbox") return Promise.resolve(entries);
        return Promise.resolve([]);
      }),
      readFile: vi.fn((entry: DirectoryEntry) => {
        if (entry.path === ".agent-collab") return Promise.resolve(MARKER);
        if (entry.path === paths[1])
          return Promise.resolve(
            messageText("2026-10-02T0902-alice-agent-api-01", "alice-agent", "api"),
          );
        secondReads();
        if (secondReads.mock.calls.length === 1) {
          return Promise.reject(
            new SourceError("rate-limited", entry.path, 403, new Date(NOW.getTime() + 20 * MINUTE)),
          );
        }
        return Promise.resolve(
          messageText("2026-10-01T0901-alice-agent-api-01", "alice-agent", "api"),
        );
      }),
      rateLimit: () => null,
    };
    const loader = new Loader(source, { pageSize: 1 });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={loader}
            title="Live demo"
            selfNames={new Set()}
            identity={{ storage: null, key: "test" }}
            notice={null}
            pollIntervalMs={5 * MINUTE}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await vi.advanceTimersByTimeAsync(0);
      for (let attempt = 0; attempt < 10 && loader.getSnapshot().items.length === 0; attempt += 1) {
        await Promise.resolve();
      }
    });
    expect(host.textContent).toContain("Live demo");
    expect(loader.getSnapshot().items).toHaveLength(1);

    const older = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Load older messages",
    );
    expect(older).toBeDefined();
    await act(async () => {
      older?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loader.getSnapshot().items).toHaveLength(1);
    expect(host.textContent).toContain("rate-limited");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
    });
    expect(head).toHaveBeenCalledOnce();
    expect(loader.getSnapshot().items).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * MINUTE);
    });
    expect(head).toHaveBeenCalledOnce();
    expect(secondReads).toHaveBeenCalledTimes(2);
    expect(loader.getSnapshot().items).toHaveLength(2);

    act(() => {
      root.unmount();
    });
  });
});

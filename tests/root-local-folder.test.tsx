import { formatDateTime } from "../src/i18n/translate";
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../src/credentials/store";
import { FixtureSource } from "../src/source/fixture";
import { FileListFolderSource } from "../src/source/file-list-folder";
import { SourceError } from "../src/source/types";
import { Root, type LocalFolderOpen, type LocalFolderSelection } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { flat, MARKER, messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ID = "2026-10-01T0901-alice-agent-api-01";

function folder(
  when: () => Date | null,
  files: Record<string, string> = {
    ".agent-collab": MARKER,
    [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "From the local clone."),
  },
): FixtureSource {
  const source = new FixtureSource(files);
  Object.assign(source, { lastChanged: when });
  return source;
}

describe("Root with a local folder", () => {
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
    vi.useRealTimers();
  });

  async function render(
    openLocalFolder: (() => Promise<LocalFolderOpen>) | null,
    storage: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
    } = { getItem: () => null, setItem: () => undefined },
    openLocalFileList?: (selection: LocalFolderSelection) => Promise<LocalFolderOpen>,
  ): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <ThemeProvider storage={storage}>
          <Root
            storage={storage}
            stores={{ memory: new MemoryStore(), "browser-encrypted": new MemoryStore() }}
            createSource={() => new FixtureSource({})}
            createDemoSource={() => new FixtureSource({})}
            createLiveDemoSource={() => new FixtureSource({})}
            openLocalFolder={openLocalFolder}
            {...(openLocalFileList === undefined ? {} : { openLocalFileList })}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    return host;
  }

  const button = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent.startsWith(text) || candidate.getAttribute("aria-label") === text,
    );

  async function click(element: Element | undefined): Promise<void> {
    expect(element).toBeDefined();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // Under fake timers a real zero-delay wait would never end.
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function chooseSelectedFiles(host: HTMLElement): Promise<void> {
    await click(button(host, "Choose local folder from files"));
    const input = host.querySelector<HTMLInputElement>('input[type="file"][webkitdirectory]');
    expect(input).not.toBeNull();
    const file = new File(["message"], "message.md");
    Object.defineProperty(file, "webkitRelativePath", { value: "clone/inbox/message.md" });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
  }

  it("offers the file-list fallback and points the unsupported browser hint to it", async () => {
    const host = await render(null, undefined, (selection) =>
      Promise.resolve({
        source: new FixtureSource({
          ".agent-collab": MARKER,
          [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api"),
        }),
        name:
          selection.kind === "files"
            ? (selection.files[0]?.webkitRelativePath.split("/")[0] ?? "clone")
            : "clone",
      }),
    );
    expect(button(host, "Open local folder")).toBeUndefined();
    expect(button(host, "Choose local folder from files")).toBeDefined();
    expect(host.querySelector(".local-unsupported")?.textContent).toContain(
      "Choose local folder from files",
    );
  });

  it("shows a neutral message when no folder is chosen or the browser refuses one", async () => {
    const open = vi.fn(() => Promise.reject(new DOMException("private detail", "AbortError")));
    const host = await render(open);
    await click(button(host, "Open local folder"));
    expect(open).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "No folder selected, or the browser does not allow this folder.",
    );
    expect(host.textContent).not.toContain("private detail");
    expect(host.querySelector(".local-unsupported")).toBeNull();
  });

  it("refuses a folder that is not a collaboration clone and stays where it was", async () => {
    const open = () =>
      Promise.resolve({ source: folder(() => null, { "README.md": "hi" }), name: "other" });
    const host = await render(open);
    await click(button(host, "Open local folder"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "not a collaboration clone",
    );
    expect(host.querySelector("h1")?.textContent).toBe("Collab Viewer");
  });

  it("shows the too-large message when building a FileList source fails", async () => {
    const openLocalFileList = () =>
      Promise.reject(new SourceError("too-large", "", null, null, "local.tooLarge"));
    const host = await render(null, undefined, openLocalFileList);

    await chooseSelectedFiles(host);

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("too large");
  });

  it("shows the non-clone message for FileList selections without inbox or topics", async () => {
    const file = new File(["not a clone"], "README.md");
    Object.defineProperty(file, "webkitRelativePath", { value: "other/README.md" });
    const openLocalFileList = () =>
      Promise.resolve({ source: new FileListFolderSource([file]), name: "other" });
    const host = await render(null, undefined, openLocalFileList);

    await chooseSelectedFiles(host);

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "not a collaboration clone",
    );
  });

  it("opens the clone read-only, labels it experimental and shows when it last changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    const changed = new Date("2026-11-03T11:55:00Z");
    const open = () => Promise.resolve({ source: folder(() => changed), name: "my-clone" });
    const host = await render(open);
    await click(button(host, "Open local folder"));

    expect(host.querySelector("h1")?.textContent).toBe("Local folder: my-clone");
    expect(host.textContent).toContain("From the local clone.");
    const indicator = host.querySelector(".source-indicator");
    expect(indicator?.textContent).toContain("Local folder");
    expect(indicator?.textContent).toContain("experimental");
    const last = host.querySelector(".last-changed");
    expect(last?.textContent).toBe("Last change seen 5 minutes ago");
    expect(last?.getAttribute("title")).toContain(formatDateTime("en", changed));
    // Read-only: nothing in the page offers to write.
    expect(button(host, "Local folder")).toBeDefined();
  });

  it("updates the last-changed time when the clone changes and the viewer refreshes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    let changed = new Date("2026-11-03T11:00:00Z");
    const source = folder(() => changed);
    const host = await render(() => Promise.resolve({ source, name: "clone" }));
    await click(button(host, "Open local folder"));
    expect(host.querySelector(".last-changed")?.textContent).toBe("Last change seen 1 hour ago");

    const second = "2026-10-01T0902-bob-agent-api-01";
    source.commit({
      ".agent-collab": MARKER,
      [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "From the local clone."),
      [flat("2026-10", 1, 2)]: messageText(second, "bob-agent", "api", {}, "Added on disk."),
    });
    changed = new Date("2026-11-03T11:59:30Z");
    await click(button(host, "Refresh"));
    expect(host.textContent).toContain("Added on disk.");
    expect(host.querySelector(".last-changed")?.textContent).toBe("Last change seen just now");
  });

  it("offers to choose a folder again from the toolbar, and keeps the viewer on a refusal", async () => {
    const calls: number[] = [];
    const open = () => {
      calls.push(1);
      return calls.length === 1
        ? Promise.resolve({ source: folder(() => null), name: "first" })
        : Promise.reject(new DOMException("x", "AbortError"));
    };
    const host = await render(open);
    await click(button(host, "Open local folder"));
    expect(host.querySelector(".last-changed")?.textContent).toBe("No file changes seen yet");
    await click(button(host, "Local folder"));
    expect(calls).toHaveLength(2);
    expect(host.querySelector("h1")?.textContent).toBe("Local folder: first");
    expect(host.querySelector(".notice")?.textContent).toBe(
      "No folder selected, or the browser does not allow this folder.",
    );
  });

  it("puts the folder button in every viewer's toolbar when a picker exists, but the indicator only on the local source", async () => {
    const host = await render(() => Promise.resolve({ source: folder(() => null), name: "clone" }));
    await click(button(host, "Open another repository"));
    await click(button(host, "Open offline demo"));
    expect(button(host, "Local folder")).toBeDefined();
    expect(host.querySelector(".source-indicator")).toBeNull();

    const without = await (async () => {
      act(() => {
        mounted?.root.unmount();
      });
      document.body.replaceChildren();
      return render(null);
    })();
    await click(button(without, "Open another repository"));
    await click(button(without, "Open offline demo"));
    expect(button(without, "Local folder")).toBeUndefined();
  });

  it("tells a blocked page apart from a cancelled picker", async () => {
    const blocked = await render(() => Promise.reject(new DOMException("x", "SecurityError")));
    await click(button(blocked, "Open local folder"));
    expect(blocked.querySelector('[role="alert"]')?.textContent).toBe(
      "The browser blocked folder access for this page.",
    );
  });

  it("refuses an enormous folder with a neutral message", async () => {
    const source = folder(() => null);
    source.head = () => Promise.reject(new SourceError("too-large", "", null, null, "x"));
    const host = await render(() => Promise.resolve({ source, name: "huge" }));
    await click(button(host, "Open local folder"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("too large");
  });

  it("does not take over the screen when the user went elsewhere while the folder was being read", async () => {
    let finish: (value: LocalFolderOpen) => void = () => undefined;
    const pending = new Promise<LocalFolderOpen>((resolve) => {
      finish = resolve;
    });
    const host = await render(() => pending);
    await click(button(host, "Open local folder"));
    await click(button(host, "Open another repository"));
    expect(host.querySelector("h1")?.textContent).toBe("Collab Viewer");
    await act(async () => {
      finish({ source: folder(() => null), name: "late" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector("h1")?.textContent).toBe("Collab Viewer");
    expect(host.textContent).not.toContain("Local folder: late");
  });

  it("keeps the messages and the folder button when a later poll loses permission", async () => {
    const source = folder(() => null);
    const head = source.head.bind(source);
    let denied = false;
    source.head = (previous) =>
      denied
        ? Promise.reject(new SourceError("forbidden", "", null, null, "x", "local-permission"))
        : head(previous);
    const host = await render(() => Promise.resolve({ source, name: "clone" }));
    await click(button(host, "Open local folder"));
    denied = true;
    await click(button(host, "Refresh"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Local folder permission needs to be granted again. Choose the folder again from the toolbar.",
    );
    expect(host.textContent).toContain("From the local clone.");
    expect(button(host, "Local folder")).toBeDefined();
  });

  describe("polling lifecycle", () => {
    function countingFolder() {
      const source = folder(() => null);
      const head = source.head.bind(source);
      const calls = { head: 0 };
      source.head = (previous) => {
        calls.head += 1;
        return head(previous);
      };
      return { source, calls };
    }

    it("polls every minute while visible, every five minutes while hidden, and stops when the viewer is left", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { source, calls } = countingFolder();
      const host = await render(() => Promise.resolve({ source, name: "clone" }));
      await click(button(host, "Open local folder"));
      const opened = calls.head;
      // The layout check and the first page share one head request.
      expect(opened).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(calls.head).toBe(opened + 1);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      const hiddenFrom = calls.head;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(calls.head).toBe(hiddenFrom);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(calls.head).toBe(hiddenFrom + 1);
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

      await click(button(host, "Settings"));
      const stopped = calls.head;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });
      expect(calls.head).toBe(stopped);
    });
  });

  describe("viewer choices kept per folder name", () => {
    const withRoster = {
      ".agent-collab": `${MARKER}participants: alice-agent, bob-agent\n`,
      [flat("2026-10", 1, 1)]: messageText(ID, "alice-agent", "api", {}, "From the local clone."),
    };
    function storageMap() {
      const values = new Map<string, string>();
      return {
        values,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      };
    }
    async function openFolder(storage: ReturnType<typeof storageMap>, name: string) {
      const host = await render(
        () => Promise.resolve({ source: folder(() => null, withRoster), name }),
        storage,
      );
      await click(button(host, "Open local folder"));
      return host;
    }
    const viewingAs = (host: HTMLElement) =>
      host.querySelector<HTMLSelectElement>(".viewing-as select");

    it("returns to the topic and the Files view of a topic-layout folder after a reload", async () => {
      const storage = storageMap();
      const layout = {
        ".agent-collab": "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent\n",
        [`topics/api/inbox/2026-10/${ID}.md`]: messageText(ID, "alice-agent", "api", {}, "Api."),
        "topics/ops/inbox/2026-10/2026-10-01T1000-alice-agent-ops-01.md": messageText(
          "2026-10-01T1000-alice-agent-ops-01",
          "alice-agent",
          "ops",
          {},
          "Ops.",
        ),
      };
      const mount = async () => {
        const host = await render(
          () => Promise.resolve({ source: folder(() => null, layout), name: "clone-t" }),
          storage,
        );
        await click(button(host, "Open local folder"));
        return host;
      };
      let host = await mount();
      await click(button(host, "#ops"));
      await click(button(host, "Files"));
      act(() => {
        mounted?.root.unmount();
      });
      document.body.replaceChildren();
      host = await mount();
      expect(host.querySelector("#conversation-heading")?.textContent).toBe("Files in #ops");
    });

    it("returns to the chosen person after a reload, and folders stay apart", async () => {
      const storage = storageMap();
      let host = await openFolder(storage, "clone-a");
      const select = viewingAs(host);
      act(() => {
        if (select === null) return;
        select.value = "alice-agent";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect([...storage.values.keys()].some((key) => key.endsWith("local:clone-a"))).toBe(true);
      expect([...storage.values.keys()].every((key) => !key.includes("/"))).toBe(true);

      act(() => {
        mounted?.root.unmount();
      });
      document.body.replaceChildren();
      host = await openFolder(storage, "clone-a");
      expect(viewingAs(host)?.value).toBe("alice-agent");

      act(() => {
        mounted?.root.unmount();
      });
      document.body.replaceChildren();
      host = await openFolder(storage, "clone-b");
      expect(viewingAs(host)?.value).toBe("");
    });
  });
});

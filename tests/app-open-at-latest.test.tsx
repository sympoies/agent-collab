// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { MARKER, messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const LINE = 300;
const VIEWPORT = 800;

function messagePath(month: string, day: number, topic: string, from = "alice-agent"): string {
  const id = `${month}-${String(day).padStart(2, "0")}T0900-${from}-${topic}-01`;
  return `inbox/${month}/${id}.md`;
}

function messageId(day: string, topic: string): string {
  return `${day}T0900-alice-agent-${topic}-01`;
}

function repository(entries: readonly (readonly [string, number, string])[]) {
  const files: Record<string, string> = { ".agent-collab": MARKER };
  for (const [month, day, topic] of entries) {
    const path = messagePath(month, day, topic);
    files[path] = messageText(path.slice(path.lastIndexOf("/") + 1, -3), "alice-agent", topic);
  }
  return files;
}

const BASE: readonly (readonly [string, number, string])[] = [
  ["2026-09", 1, "api"],
  ["2026-09", 2, "api"],
  ["2026-10", 1, "api"],
  ["2026-10", 2, "ops"],
  ["2026-10", 3, "api"],
  ["2026-10", 4, "ops"],
];

describe("a conversation opens at its latest message", () => {
  let mounted: { host: HTMLElement; root: Root } | null = null;
  let scrollY = 0;
  let scrollTo: ReturnType<typeof vi.fn>;

  // happy-dom has no layout: the pane is as tall as its messages and scrolls through scrollTo.
  const pageHeight = () => 700 + LINE * document.querySelectorAll(".message").length;
  const bottom = () => pageHeight() - VIEWPORT;
  const pane = () => document.querySelector<HTMLElement>("main.conversation") as HTMLElement;
  const isPane = (node: unknown) =>
    node instanceof HTMLElement && node.matches("main.conversation");
  const scrollByReader = (y: number) => {
    scrollY = y;
    pane().dispatchEvent(new Event("scroll"));
  };
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    scrollY = 0;
    const define = (name: string, descriptor: PropertyDescriptor) => {
      saved.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
    };
    define("scrollTop", { get: () => scrollY });
    define("scrollHeight", {
      get(this: HTMLElement) {
        return isPane(this) ? pageHeight() : 0;
      },
    });
    define("clientHeight", {
      get(this: HTMLElement) {
        return isPane(this) ? VIEWPORT : 0;
      },
    });
    scrollTo = vi.fn((options: ScrollToOptions) => {
      scrollY = Math.max(0, Math.min(options.top ?? 0, bottom()));
      pane().dispatchEvent(new Event("scroll"));
    });
    define("scrollTo", { value: scrollTo, writable: true });
    // Messages stack LINE apart in the pane; the pane starts at the top of the viewport.
    define("getBoundingClientRect", {
      value(this: HTMLElement) {
        const index = isPane(this) ? -1 : [...document.querySelectorAll(".message")].indexOf(this);
        const top = index < 0 ? 0 : index * LINE - scrollY;
        return { top, bottom: top + LINE, left: 0, right: 0, width: 0, height: LINE, x: 0, y: top };
      },
      writable: true,
    });
    window.location.hash = "";
  });

  afterEach(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(proto, name);
      else Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
    saved.clear();
    if (mounted !== null) {
      const { root } = mounted;
      act(() => {
        root.unmount();
      });
    }
    mounted = null;
    document.body.replaceChildren();
  });

  async function render(source: FixtureSource, pageSize = 50) {
    const loader = new Loader(source, { pageSize });
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
            identity={{ storage: null, key: "test" }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    return { host, loader };
  }

  const button = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll("button")].find((candidate) =>
      candidate.textContent.startsWith(text),
    );

  async function click(element: Element | undefined): Promise<void> {
    expect(element).toBeDefined();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }

  it("scrolls the newest message to the bottom when the conversation is first shown", async () => {
    await render(new FixtureSource(repository(BASE)));
    expect(scrollY).toBe(bottom());
    expect(scrollY).toBeGreaterThan(0);
  });

  it("scrolls without animation and without moving focus", async () => {
    const { host } = await render(new FixtureSource(repository(BASE)));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "instant" }));
    expect(host.contains(document.activeElement) && document.activeElement !== document.body).toBe(
      false,
    );
  });

  it("lands at the latest message of another topic after switching", async () => {
    const { host } = await render(new FixtureSource(repository(BASE)));
    scrollByReader(0);
    await click(button(host, "#ops"));
    expect(scrollY).toBe(bottom());
    expect(bottom()).toBe(700 + 2 * LINE - VIEWPORT);
    expect(bottom()).toBeGreaterThan(0);
  });

  it("follows a new message while the reader is at the bottom", async () => {
    const source = new FixtureSource(repository(BASE));
    const { loader } = await render(source);
    source.commit(repository([...BASE, ["2026-10", 5, "api"]]));
    await act(async () => {
      await loader.refresh();
    });
    expect(document.querySelectorAll(".message")).toHaveLength(7);
    expect(scrollY).toBe(bottom());
  });

  it("leaves a reader who scrolled up where they are when a message arrives", async () => {
    const source = new FixtureSource(repository(BASE));
    const { loader } = await render(source);
    scrollByReader(50);
    source.commit(repository([...BASE, ["2026-10", 5, "api"]]));
    await act(async () => {
      await loader.refresh();
    });
    expect(document.querySelectorAll(".message")).toHaveLength(7);
    expect(scrollY).toBe(50);
  });

  it("keeps the visible message in place when older messages are loaded", async () => {
    const { host } = await render(new FixtureSource(repository(BASE)), 2);
    expect(document.querySelectorAll(".message")).toHaveLength(2);
    scrollByReader(0);
    scrollTo.mockClear();
    await click(button(host, "Load older"));
    expect(document.querySelectorAll(".message")).toHaveLength(4);
    // Two older messages were added above: the reader's content moved down by their height.
    expect(scrollY).toBe(2 * LINE);
  });

  it("does not override a message opened from the Questions view", async () => {
    const files = repository(BASE);
    const questionPath = messagePath("2026-09", 1, "api");
    files[questionPath] = messageText(
      "2026-09-01T0900-alice-agent-api-01",
      "alice-agent",
      "api",
      { type: "question", to: "bob-agent" },
      "Is it final?",
    );
    files[".agent-collab"] = "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n";
    const { host } = await render(new FixtureSource(files));
    await click(button(host, "Questions"));
    scrollByReader(0);
    scrollTo.mockClear();
    const open = host.querySelector('section[aria-label="Open"] .question-open-chat');
    await click(open ?? undefined);
    expect(
      document
        .getElementById("msg-2026-09-01T0900-alice-agent-api-01")
        ?.hasAttribute("data-jumped"),
    ).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollY).toBe(0);
  });

  it("keeps a message that the address already names", async () => {
    window.location.hash = `#msg-${messageId("2026-09-01", "api")}`;
    await render(new FixtureSource(repository(BASE)));
    expect(document.getElementById(`msg-${messageId("2026-09-01", "api")}`)).not.toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollY).toBe(0);
  });

  async function jumpToDate(host: HTMLElement, date: string) {
    const input = host.querySelector<HTMLInputElement>('input[type="date"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, date);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("lands at the start of the requested day after Jump to date, even from the bottom", async () => {
    const source = new FixtureSource(repository(BASE));
    const { host, loader } = await render(source);
    expect(scrollY).toBe(bottom());
    await jumpToDate(host, "2026-10-02");
    // The page ends on that day: 09-01, 09-02, 10-01 and the two messages of 10-02 are loaded
    // in order, and the day starts at the fourth message, above the bottom.
    const ids = [...document.querySelectorAll(".message")].map((node) => node.id);
    const day = ids.findIndex((id) => id.startsWith("msg-2026-10-02T"));
    expect(day).toBeGreaterThan(0);
    expect(scrollY).toBe(day * LINE);
    expect(scrollY).toBeLessThan(bottom());
    // Following is off: a new message does not pull the reader down.
    source.commit(repository([...BASE, ["2026-10", 5, "api"]]));
    await act(async () => {
      await loader.refresh();
    });
    expect(scrollY).toBe(day * LINE);
  });
});

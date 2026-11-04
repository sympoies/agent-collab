// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { SourceError } from "../src/source/types";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeIntersectionObserver {
  static readonly instances: FakeIntersectionObserver[] = [];
  target: Element | null = null;
  disconnected = false;

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  unobserve(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  fire(target: Element, isIntersecting: boolean): void {
    if (this.target !== target || this.disconnected) {
      throw new Error("Observer is not watching the topic button.");
    }
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const API_ID = "2026-10-01T0900-alice-agent-api-01";
const OPS_ID = "2026-10-01T1000-bob-agent-ops-01";
const DOCS_ID = "2026-10-01T1100-alice-agent-docs-01";
const files = {
  ".agent-collab":
    "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n",
  "index.md": [
    "| topic | title | status |",
    "|---|---|---|",
    "| api | The API | open |",
    "| ops | Operations | open |",
    "| docs | Documentation | open |",
    "| archive | Archive | closed |",
  ].join("\n"),
  [`topics/api/inbox/2026-10/${API_ID}.md`]: messageText(API_ID, "alice-agent", "api"),
  [`topics/ops/inbox/2026-10/${OPS_ID}.md`]: messageText(OPS_ID, "bob-agent", "ops"),
  [`topics/docs/inbox/2026-10/${DOCS_ID}.md`]: messageText(DOCS_ID, "alice-agent", "docs"),
  "topics/archive/TOPIC.md": "---\nstatus: closed\n---\n",
};

describe("topic list screen", () => {
  let root: Root | null = null;
  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("shows topics without messages, opens topics on demand, and merges only loaded topics in All", async () => {
    const source = new FixtureSource(files);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={new Loader(source)}
            topicSource={source}
            title="Repository"
            selfNames={new Set()}
            identity={{ storage: null, key: "topic-test" }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect([...host.querySelectorAll("h1")]).toHaveLength(1);
    expect(host.textContent).toContain("The API");
    expect(host.querySelector<HTMLDetailsElement>(".closed-topics")?.open).toBe(false);
    expect(source.reads).toContain(".agent-collab");
    expect(source.reads).toContain("index.md");
    expect(source.reads.some((path) => path.endsWith(".md") && path !== "index.md")).toBe(false);

    const api = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "The API",
    );
    expect(api).toBeDefined();
    await act(async () => {
      api?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(source.reads).toContain(`topics/api/inbox/2026-10/${API_ID}.md`);
    expect(source.reads).not.toContain(`topics/ops/inbox/2026-10/${OPS_ID}.md`);

    const ops = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Operations",
    );
    await act(async () => {
      ops?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(source.reads).toContain(`topics/ops/inbox/2026-10/${OPS_ID}.md`);
    expect(source.reads).not.toContain(`topics/docs/inbox/2026-10/${DOCS_ID}.md`);

    const all = [...host.querySelectorAll("button")].find((button) => button.textContent === "All");
    await act(async () => {
      all?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.textContent).toContain(API_ID);
    expect(host.textContent).toContain(OPS_ID);
    expect(source.reads).not.toContain(`topics/docs/inbox/2026-10/${DOCS_ID}.md`);
  });

  it("does not open the merged loader after a transient topic discovery failure", async () => {
    const source = new FixtureSource(files);
    const head = source.head.bind(source);
    let first = true;
    source.head = (previous) => {
      if (first) {
        first = false;
        return Promise.reject(new SourceError("unreachable", ""));
      }
      return head(previous);
    };
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={new Loader(source)}
            topicSource={source}
            title="Repository"
            selfNames={new Set()}
            identity={{ storage: null, key: "topic-retry-test" }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(source.reads).not.toContain(`topics/api/inbox/2026-10/${API_ID}.md`);
    expect(host.querySelector(".error")).not.toBeNull();
    const refresh = [...host.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Refresh",
    );
    await act(async () => {
      refresh?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain("The API");
    expect(source.reads).not.toContain(`topics/api/inbox/2026-10/${API_ID}.md`);
  });

  it("retries failed activity when the topic leaves and re-enters the viewport", async () => {
    const apiId = "2026-11-01T0900-alice-agent-api-01";
    const docsId = "2026-10-01T0900-bob-agent-docs-01";
    const source = new FixtureSource({
      ".agent-collab": "collab-protocol: 1\ninbox-layout: topic\n",
      "index.md":
        "| topic | title | status |\n|---|---|---|\n| api | API | open |\n| docs | Docs | open |",
      [`topics/api/inbox/2026-11/${apiId}.md`]: messageText(apiId, "alice-agent", "api"),
      [`topics/docs/inbox/2026-10/${docsId}.md`]: messageText(docsId, "bob-agent", "docs"),
    });
    const listDirectory = source.listDirectory.bind(source);
    let apiAttempts = 0;
    source.listDirectory = (revision, path) => {
      if (path === "topics/api") {
        apiAttempts += 1;
        if (apiAttempts === 1) return Promise.reject(new SourceError("unreachable", path));
      }
      return listDirectory(revision, path);
    };
    FakeIntersectionObserver.instances.length = 0;
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={new Loader(source)}
            topicSource={source}
            title="Repository"
            selfNames={new Set()}
            identity={{ storage: null, key: "topic-activity-retry" }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const apiButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "API",
    );
    const docsButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Docs",
    );
    expect(apiButton).toBeDefined();
    expect(docsButton).toBeDefined();
    const observerFor = (button: Element) =>
      FakeIntersectionObserver.instances.find((observer) => observer.target === button);
    const apiObserver = observerFor(apiButton as Element);
    const docsObserver = observerFor(docsButton as Element);
    expect(apiObserver).toBeDefined();
    expect(docsObserver).toBeDefined();

    await act(async () => {
      docsObserver?.fire(docsButton as Element, true);
      apiObserver?.fire(apiButton as Element, true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiAttempts).toBe(1);
    const beforeRetry = [...host.querySelectorAll(".topics > button")].map(
      (button) => button.textContent,
    );
    expect(beforeRetry.indexOf("Docs")).toBeLessThan(beforeRetry.indexOf("API"));
    expect(apiObserver?.disconnected).toBe(false);

    await act(async () => {
      apiObserver?.fire(apiButton as Element, false);
      apiObserver?.fire(apiButton as Element, true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiAttempts).toBe(2);
    const afterRetry = [...host.querySelectorAll(".topics > button")].map(
      (button) => button.textContent,
    );
    expect(afterRetry.indexOf("API")).toBeLessThan(afterRetry.indexOf("Docs"));
    expect(apiObserver?.disconnected).toBe(true);
    expect(source.reads).not.toContain(`topics/api/inbox/2026-11/${apiId}.md`);
  });
});

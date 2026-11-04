// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { SourceError } from "../src/source/types";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const API_ID = "2026-10-01T0900-alice-agent-api-01";
const OPS_ID = "2026-10-01T1000-bob-agent-ops-01";
const DOCS_ID = "2026-10-01T1100-alice-agent-docs-01";
const MARKER = "collab-protocol: 1\ninbox-layout: topic\nparticipants: alice-agent, bob-agent\n";
const files: Record<string, string> = {
  ".agent-collab": MARKER,
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
  "topics/archive/inbox/2026-01/2026-01-01T0900-alice-agent-archive-01.md": messageText(
    "2026-01-01T0900-alice-agent-archive-01",
    "alice-agent",
    "archive",
  ),
};

describe("topic list screen", () => {
  let root: Root | null = null;
  let host: HTMLElement;
  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  async function settle(): Promise<void> {
    await act(async () => {
      for (let round = 0; round < 4; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }

  async function mount(source: FixtureSource, key = "topic-test"): Promise<void> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={new Loader(source)}
            topicSource={source}
            title="Repository"
            selfNames={new Set()}
            identity={{ storage: null, key }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
    });
    await settle();
  }

  const entries = () => [...host.querySelectorAll<HTMLButtonElement>(".topics button")];
  const entry = (label: string) => {
    const found = entries().find((button) => button.textContent.startsWith(label));
    if (found === undefined) throw new Error(`No entry starts with ${label}`);
    return found;
  };
  const rowLabels = () =>
    [...host.querySelectorAll(".topics > button:not(.show-all-topics)")]
      .map((button) => button.textContent)
      .filter((text) => text !== "");

  async function click(button: Element): Promise<void> {
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
  }

  it("lists All, Questions and Files before the topics and reads no digest from a message", async () => {
    const source = new FixtureSource(files);
    await mount(source);

    expect([...host.querySelectorAll("h1")]).toHaveLength(1);
    expect(
      rowLabels()
        .slice(0, 3)
        .map((text) => text.replace(/\d+ open$/, "")),
    ).toEqual(["All", "Questions", "Files"]);
    // Most recent activity first, the closed topic only in its collapsed group.
    expect(rowLabels().slice(3)).toEqual(["#docs", "#ops", "#api"]);
    expect(host.querySelector<HTMLDetailsElement>(".closed-topics")?.open).toBe(false);
    expect(host.querySelector(".closed-topics summary")?.textContent).toBe("Closed (1)");

    await click(entry("#api"));
    expect(host.querySelector("h2.topic-heading")?.textContent).toBe("#api");
    // Questions and Files read the same loaded messages.
    await click(entry("All"));
    await click(entry("Files"));
    expect(host.querySelector("#conversation-heading")?.textContent).toBe("Files");
  });

  describe("the All view", () => {
    const text = () => host.querySelector("main")?.textContent ?? "";
    const inOrder = (...ids: string[]) => {
      const positions = ids.map((id) => text().indexOf(id));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    };

    /** Holds every topic inbox listing until released, so the loading state can be observed. */
    function gated(source: FixtureSource): () => void {
      const list = source.listDirectory.bind(source);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      source.listDirectory = async (revision, path) => {
        if (/^topics\/[^/]+\/inbox$/.test(path)) await gate;
        return list(revision, path);
      };
      return release;
    }

    it("shows every open topic right after a reload, and a loading state meanwhile", async () => {
      const source = new FixtureSource(files);
      const release = gated(source);
      await mount(source);

      expect(host.querySelector("p.empty")?.textContent).toBe("Loading messages…");
      expect(host.querySelector('[role="status"].all-status')?.textContent).toBe(
        "Loading topics: 0 of 3",
      );
      expect(text()).toContain("Loading messages");

      release();
      await settle();
      inOrder(API_ID, OPS_ID, DOCS_ID);
      expect(host.querySelector("p.empty")).toBeNull();
      expect(host.querySelector(".all-status")?.textContent).toBe(
        "Closed topics appear here once opened.",
      );
      expect(text()).not.toContain("2026-01-01T0900-alice-agent-archive-01");
    });

    it("is complete after opening topic A and going back to All", async () => {
      const source = new FixtureSource(files);
      await mount(source);
      await click(entry("#api"));
      await click(entry("All"));
      inOrder(API_ID, OPS_ID, DOCS_ID);
    });

    it("holds the union, ordered by time, after opening topics A and B and going back to All", async () => {
      const source = new FixtureSource(files);
      await mount(source);
      await click(entry("#ops"));
      await click(entry("#api"));
      await click(entry("All"));
      inOrder(API_ID, OPS_ID, DOCS_ID);
    });

    it("adds a closed topic once it was opened", async () => {
      const source = new FixtureSource(files);
      await mount(source);
      act(() => {
        (host.querySelector(".closed-topics summary") as HTMLElement).click();
      });
      await settle();
      await click(entry("#archive"));
      await click(entry("All"));
      inOrder("2026-01-01T0900-alice-agent-archive-01", API_ID);
    });

    /** Ten topics, one message each; `topic-NN` is the NNth. */
    function many(): Record<string, string> {
      const repository: Record<string, string> = { ".agent-collab": MARKER };
      for (let index = 1; index <= 10; index += 1) {
        const name = `topic-${String(index).padStart(2, "0")}`;
        const id = `2026-10-${String(index).padStart(2, "0")}T0900-alice-agent-${name}-01`;
        repository[`topics/${name}/inbox/2026-10/${id}.md`] = messageText(id, "alice-agent", name);
      }
      return repository;
    }
    const messagePath = (name: string) =>
      `topics/${name}/inbox/2026-10/2026-10-${name.slice(-2)}T0900-alice-agent-${name}-01.md`;

    /**
     * Holds every message file read (the activity reads never read one); `topics()` are the topics
     * whose messages were asked for so far.
     */
    function counted(source: FixtureSource) {
      const read = source.readFile.bind(source);
      const asked = new Set<string>();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      source.readFile = async (entry) => {
        const topic = /^topics\/([^/]+)\/inbox\//.exec(entry.path)?.[1];
        if (topic !== undefined) {
          asked.add(topic);
          await gate;
        }
        return read(entry);
      };
      return { topics: () => asked.size, release };
    }

    it("reads four topics at a time and stops the queue when All is left", async () => {
      const source = new FixtureSource(many());
      const reads = counted(source);
      await mount(source);
      expect(reads.topics()).toBe(4);
      expect(host.querySelector(".all-status")?.textContent).toBe("Loading topics: 0 of 10");

      await click(entry("#topic-01"));
      reads.release();
      await settle();
      await settle();
      // Only the four in flight finished; the six not yet started were never read.
      expect(reads.topics()).toBe(4);
    });

    it("does not read a topic All has not reached when the topic list refreshes", async () => {
      const files10 = many();
      const source = new FixtureSource(files10);
      const reads = counted(source);
      await mount(source);
      await click(entry("#topic-01"));
      // The reads in flight finish first; the Refresh button waits while a topic is opening.
      reads.release();
      await settle();

      source.commit({
        ...files10,
        "topics/topic-10/inbox/2026-10/2026-10-20T0900-alice-agent-topic-10-01.md": messageText(
          "2026-10-20T0900-alice-agent-topic-10-01",
          "alice-agent",
          "topic-10",
        ),
      });
      await click(host.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement);
      await settle();
      expect(source.reads.filter((path) => path.includes("topics/topic-10/inbox/"))).toEqual([]);
      expect(source.reads).toContain(messagePath("topic-01"));
    });

    it("keeps the count short and the error visible when a topic cannot be read, until the next refresh", async () => {
      const source = new FixtureSource(files);
      const list = source.listDirectory.bind(source);
      let failing = true;
      source.listDirectory = (revision, path) =>
        failing && path === "topics/ops/inbox"
          ? Promise.reject(new SourceError("unreachable", ""))
          : list(revision, path);
      await mount(source);
      expect(host.querySelector(".all-status")?.textContent).toBe("Loading topics: 2 of 3");
      expect(host.querySelector(".error")).not.toBeNull();
      expect(text()).not.toContain(OPS_ID);

      failing = false;
      await click(host.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement);
      expect(text()).toContain(OPS_ID);
      expect(host.querySelector(".all-status")?.textContent).toBe(
        "Closed topics appear here once opened.",
      );
    });

    it("says there are no messages only when no topic has any", async () => {
      const source = new FixtureSource({
        ".agent-collab": MARKER,
        "topics/quiet/TOPIC.md": "---\ntitle: Quiet\n---\n",
      });
      const release = gated(source);
      await mount(source);
      expect(host.querySelector("p.empty")?.textContent).toBe("Loading messages…");
      release();
      await settle();
      expect(host.querySelector("p.empty")?.textContent).toBe("No messages yet.");
    });
  });

  it("shows in All a message that arrived while its topic was open", async () => {
    const source = new FixtureSource(files);
    await mount(source);
    await click(entry("#api"));

    const late = "2026-10-02T0900-bob-agent-api-01";
    source.commit({
      ...files,
      [`topics/api/inbox/2026-10/${late}.md`]: messageText(late, "bob-agent", "api"),
    });
    const refresh = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');
    expect(refresh).not.toBeNull();
    await click(refresh as HTMLButtonElement);
    expect(host.textContent).toContain(late);

    await click(entry("All"));
    expect(host.textContent).toContain(late);
    expect(host.textContent).toContain(API_ID);
  });

  it("updates the topic list and its order after a refresh", async () => {
    const source = new FixtureSource(files);
    await mount(source);
    expect(rowLabels().slice(3)).toEqual(["#docs", "#ops", "#api"]);

    const late = "2026-10-05T0900-bob-agent-api-01";
    const fresh = "2026-10-04T0900-bob-agent-fresh-01";
    source.commit({
      ...files,
      "index.md": `${files["index.md"] ?? ""}\n| fresh | Fresh topic | open |`,
      [`topics/api/inbox/2026-10/${late}.md`]: messageText(late, "bob-agent", "api"),
      [`topics/fresh/inbox/2026-10/${fresh}.md`]: messageText(fresh, "bob-agent", "fresh"),
    });
    await click(host.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement);

    expect(rowLabels().slice(3)).toEqual(["#api", "#fresh", "#docs", "#ops"]);
  });

  it("moves a topic with a newer reply to the top after a refresh without moving the reader", async () => {
    const source = new FixtureSource(files);
    await mount(source);
    await click(entry("#ops"));
    expect(entry("#ops").getAttribute("aria-pressed")).toBe("true");

    const reply = "2026-10-06T0900-alice-agent-api-02";
    const commit = () => {
      source.commit({
        ...files,
        [`topics/api/inbox/2026-10/${reply}.md`]: messageText(reply, "alice-agent", "api", {
          type: "ack",
          reply_to: API_ID,
        }),
      });
    };
    // Focus inside the list holds the order, whatever a refresh brings.
    act(() => {
      entry("#docs").focus();
    });
    commit();
    await click(host.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement);
    expect(rowLabels().slice(3)).toEqual(["#docs", "#ops", "#api"]);

    // Leaving the list applies it; the open topic stays open and listed.
    act(() => {
      entry("#docs").blur();
    });
    await settle();
    expect(rowLabels().slice(3)).toEqual(["#api", "#docs", "#ops"]);
    expect(entry("#ops").getAttribute("aria-pressed")).toBe("true");
  });

  it("retries a topic whose activity could not be read on the next refresh", async () => {
    const source = new FixtureSource(files);
    source.failListings(["topics/api"]);
    await mount(source);
    expect(host.querySelector(".error")).not.toBeNull();
    // The topic stays listed, after the ones whose activity is known.
    expect(rowLabels().slice(3)).toEqual(["#docs", "#ops", "#api"]);

    source.failListings([]);
    source.commit({ ...files });
    await click(host.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement);
    expect(host.querySelector(".error")).toBeNull();
    expect(source.listings.filter((path) => path === "topics/api").length).toBeGreaterThan(1);
  });

  it("reads closed topics' activity only when their group is opened", async () => {
    const source = new FixtureSource(files);
    await mount(source);
    expect(source.listings).not.toContain("topics/archive");

    const group = host.querySelector<HTMLDetailsElement>(".closed-topics");
    act(() => {
      if (group !== null) group.open = true;
      group?.dispatchEvent(new Event("toggle"));
    });
    await settle();
    expect(source.listings).toContain("topics/archive");
    // All reads the open topics; a closed topic's messages stay unread until it is opened.
    expect(source.reads.filter((path) => path.includes("topics/archive/inbox/"))).toEqual([]);
  });

  it("shows the twelve most recent topics, a Show all button and always the selected topic", async () => {
    const many: Record<string, string> = { ".agent-collab": MARKER };
    for (let index = 1; index <= 14; index += 1) {
      const name = `topic-${String(index).padStart(2, "0")}`;
      const id = `2026-10-${String(index).padStart(2, "0")}T0900-alice-agent-${name}-01`;
      many[`topics/${name}/inbox/2026-10/${id}.md`] = messageText(id, "alice-agent", name);
    }
    const source = new FixtureSource(many);
    await mount(source);

    expect(rowLabels().slice(3)).toHaveLength(12);
    expect(rowLabels()[3]).toBe("#topic-14");
    expect(rowLabels()).not.toContain("#topic-02");
    const toggle = host.querySelector<HTMLButtonElement>("button.show-all-topics");
    expect(toggle?.textContent).toBe("Show all 14 topics");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    toggle?.focus();
    await click(toggle as HTMLButtonElement);
    expect(rowLabels().slice(3)).toHaveLength(14);
    expect(toggle?.textContent).toBe("Show fewer");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    // The same button keeps focus.
    expect(document.activeElement).toBe(toggle);

    await click(entry("#topic-01"));
    await click(host.querySelector("button.show-all-topics") as HTMLButtonElement);
    const names = rowLabels().slice(3);
    expect(names).toContain("#topic-01");
    expect(names).not.toContain("#topic-02");
    expect(names).toHaveLength(13);
    expect(host.querySelector("button.show-all-topics")?.textContent).toBe("Show all 14 topics");
  });

  it("lists a closed topic that is open while its group is collapsed", async () => {
    const source = new FixtureSource(files);
    await mount(source);
    const toggle = async (open: boolean) => {
      const group = host.querySelector<HTMLDetailsElement>(".closed-topics");
      act(() => {
        if (group !== null) group.open = open;
        group?.dispatchEvent(new Event("toggle"));
      });
      await settle();
    };
    await toggle(true);
    await click(entry("#archive"));
    await toggle(false);
    expect(rowLabels()).toContain("#archive");
    expect(entry("#archive").getAttribute("aria-pressed")).toBe("true");
  });

  it("reads activity four topics at a time, joins reads in progress and stops when left", async () => {
    const many: Record<string, string> = { ".agent-collab": MARKER };
    for (let index = 1; index <= 10; index += 1) {
      const name = `topic-${String(index).padStart(2, "0")}`;
      const id = `2026-10-${String(index).padStart(2, "0")}T0900-alice-agent-${name}-01`;
      many[`topics/${name}/inbox/2026-10/${id}.md`] = messageText(id, "alice-agent", name);
    }
    const source = new FixtureSource(many);
    const list = source.listDirectory.bind(source);
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.listDirectory = async (revision, path) => {
      if (/^topics\/[^/]+$/.test(path)) {
        started.push(path);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight -= 1;
      }
      return list(revision, path);
    };
    await mount(source);
    expect(started).toHaveLength(4);
    expect(peak).toBe(4);

    // A refresh while those reads are in progress joins them instead of repeating them.
    source.commit({ ...many });
    await click(host.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement);
    expect(started).toHaveLength(4);

    release();
    await settle();
    await settle();
    expect(peak).toBe(4);
    expect([...new Set(started)]).toHaveLength(10);
    expect(started).toHaveLength(10);
  });

  it("stops reading activity when the viewer is left", async () => {
    const many: Record<string, string> = { ".agent-collab": MARKER };
    for (let index = 1; index <= 10; index += 1) {
      const name = `topic-${String(index).padStart(2, "0")}`;
      const id = `2026-10-${String(index).padStart(2, "0")}T0900-alice-agent-${name}-01`;
      many[`topics/${name}/inbox/2026-10/${id}.md`] = messageText(id, "alice-agent", name);
    }
    const source = new FixtureSource(many);
    const list = source.listDirectory.bind(source);
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.listDirectory = async (revision, path) => {
      if (/^topics\/[^/]+$/.test(path)) {
        started.push(path);
        await gate;
      }
      return list(revision, path);
    };
    await mount(source);
    expect(started).toHaveLength(4);
    act(() => root?.unmount());
    root = null;
    release();
    await settle();
    expect(started).toHaveLength(4);
  });

  it("stays on the topic list with a retry after a transient discovery failure", async () => {
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
    await mount(source, "topic-retry-test");

    expect(source.reads.filter((path) => path.includes("/inbox/"))).toEqual([]);
    expect(host.querySelector(".error")).not.toBeNull();
    await click(host.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement);

    expect(host.textContent).toContain("#api");
    expect(source.reads).toContain(`topics/api/inbox/2026-10/${API_ID}.md`);
  });
});

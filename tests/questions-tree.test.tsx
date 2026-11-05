// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { PreferenceStorage } from "../src/identity/preferences";
import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const KEY = "hosted:test";
const VIEW_KEY = `agent-collab-viewer.view:${KEY}`;
const Q_CAROL = "2026-10-01T0900-alice-agent-api-01"; // to bob and carol; bob answered
const A_BOB = "2026-10-01T0905-bob-agent-api-01";
const Q_BOB_DONE = "2026-10-01T0910-alice-agent-api-02"; // to bob; answered
const A_BOB_DONE = "2026-10-01T0915-bob-agent-api-02";
const Q_ALICE = "2026-10-01T0920-carol-agent-api-03"; // to alice
const Q_BOB = "2026-10-01T0930-alice-agent-ops-01"; // to bob
const files = {
  ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent, bob-agent, carol-agent\n",
  [`inbox/${Q_CAROL}.md`]: messageText(Q_CAROL, "alice-agent", "api", {
    type: "question",
    to: "bob-agent, carol-agent",
    needs: "answer",
  }),
  [`inbox/${A_BOB}.md`]: messageText(A_BOB, "bob-agent", "api", {
    type: "answer",
    to: "alice-agent",
    reply_to: Q_CAROL,
  }),
  [`inbox/${Q_BOB_DONE}.md`]: messageText(Q_BOB_DONE, "alice-agent", "api", {
    type: "question",
    to: "bob-agent",
    needs: "answer",
  }),
  [`inbox/${A_BOB_DONE}.md`]: messageText(A_BOB_DONE, "bob-agent", "api", {
    type: "answer",
    to: "alice-agent",
    reply_to: Q_BOB_DONE,
  }),
  [`inbox/${Q_ALICE}.md`]: messageText(Q_ALICE, "carol-agent", "api", {
    type: "question",
    to: "alice-agent",
    needs: "answer",
  }),
  [`inbox/${Q_BOB}.md`]: messageText(Q_BOB, "alice-agent", "ops", {
    type: "question",
    to: "bob-agent",
    needs: "answer",
  }),
};

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const storage: PreferenceStorage & { readonly values: Map<string, string> } = {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return storage;
}

describe("the tree in the left list", () => {
  let root: Root | null = null;
  afterEach(() => {
    if (root !== null) {
      const mounted = root;
      act(() => {
        mounted.unmount();
      });
    }
    root = null;
    document.body.replaceChildren();
  });

  async function render(
    storage: PreferenceStorage | null,
    rememberView = true,
    rosterKnown = true,
  ) {
    const source = new FixtureSource(files);
    // A browser folder input that omits the marker cannot name the participants: every question
    // is in the unknown state.
    if (!rosterKnown) Object.assign(source, { participantsKnown: false });
    const loader = new Loader(source);
    await loader.open();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const mounted = root;
    await act(async () => {
      mounted.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <App
            loader={loader}
            title="Repo"
            selfNames={new Set(["alice-agent"])}
            identity={{ storage, key: KEY }}
            rememberView={rememberView}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    return host;
  }
  async function click(element: Element | null | undefined): Promise<void> {
    expect(element).toBeTruthy();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }
  const questionsRow = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLButtonElement>(".topics > button")].find((button) =>
      button.textContent.startsWith("Questions"),
    );
  const child = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>(".questions-tree button")].find((button) =>
      button.textContent.startsWith(text),
    );
  const shown = (host: HTMLElement) => host.querySelectorAll(".question-item").length;

  it("groups the views first and puts a Topics heading above the topics", async () => {
    const host = await render(null);
    // No "Topics" header over the views.
    expect(host.querySelector(".topics-pane > h2")).toBeNull();
    const nav = host.querySelector(".topics");
    const order = [...(nav?.children ?? [])].map(
      (node) => node.tagName + ":" + (node.className === "topics-heading" ? node.textContent : ""),
    );
    const heading = order.findIndex((entry) => entry === "H2:Topics");
    expect(heading).toBeGreaterThan(2);
    // All, Questions and Files come before it; the topic entries after it.
    expect(
      [...(nav?.children ?? [])]
        .slice(0, heading)
        .map((node) => node.textContent.replace(/\d.*$/, "").replace(/\s+$/, "")),
    ).toEqual(["All", "Questions", "Files"]);
  });

  it("opens the page with every question and expands the node", async () => {
    const host = await render(null);
    expect(questionsRow(host)?.getAttribute("aria-expanded")).toBe("false");
    await click(questionsRow(host));
    expect(shown(host)).toBe(4);
    expect(questionsRow(host)?.getAttribute("aria-expanded")).toBe("true");
    // Open (3 questions), one row per person who still owes an answer, then Answered (1).
    const rows = [...host.querySelectorAll(".questions-tree button")].map((b) => b.textContent);
    expect(rows).toEqual(["Open3", "alice-agent1", "bob-agent1", "carol-agent1", "Answered1"]);
  });

  it("filters to open, to one person and to answered, and clears", async () => {
    const host = await render(null);
    await click(questionsRow(host));
    await click(child(host, "Open"));
    expect(shown(host)).toBe(3);
    expect(host.querySelector(".question-filter")?.textContent).toContain("open questions");
    await click(child(host, "carol-agent"));
    expect(shown(host)).toBe(1);
    expect(host.querySelector(".question-text")?.textContent).toContain(Q_CAROL);
    expect(child(host, "carol-agent")?.getAttribute("aria-pressed")).toBe("true");
    await click(child(host, "Answered"));
    expect(shown(host)).toBe(1);
    await click(host.querySelector(".question-filter button"));
    expect(shown(host)).toBe(4);
    expect(host.querySelector(".question-filter")).toBeNull();
  });

  it("the Questions row opens the page with everything again, and a second press collapses", async () => {
    const host = await render(null);
    await click(questionsRow(host));
    await click(child(host, "bob-agent"));
    expect(shown(host)).toBe(1);
    await click(questionsRow(host));
    expect(shown(host)).toBe(4);
    expect(questionsRow(host)?.getAttribute("aria-expanded")).toBe("true");
    await click(questionsRow(host));
    expect(questionsRow(host)?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".questions-tree")).toBeNull();
  });

  it("remembers the filter and the expansion across a reload", async () => {
    const storage = memoryStorage();
    let host = await render(storage);
    await click(questionsRow(host));
    await click(child(host, "carol-agent"));
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    host = await render(storage);
    expect(shown(host)).toBe(1);
    expect(questionsRow(host)?.getAttribute("aria-expanded")).toBe("true");
    expect(child(host, "carol-agent")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores a saved person who is no longer pending, without an error", async () => {
    const storage = memoryStorage({
      [VIEW_KEY]: JSON.stringify({
        view: "questions",
        topic: null,
        conversation: false,
        questions: { open: true, filter: { kind: "person", person: "ghost-agent" } },
      }),
    });
    const host = await render(storage);
    expect(shown(host)).toBe(4);
    expect(host.querySelector(".question-filter")).toBeNull();
    expect(host.querySelector(".error")).toBeNull();
  });

  it("remembers nothing where the view is not remembered (demos, GitHub)", async () => {
    const storage = memoryStorage();
    const host = await render(storage, false);
    await click(questionsRow(host));
    await click(child(host, "carol-agent"));
    expect(shown(host)).toBe(1);
    expect([...storage.values.keys()].filter((key) => key.includes(".view:"))).toEqual([]);
  });

  it("renders topic rows as plain text, with the chip kept in the message meta line", async () => {
    const host = await render(null);
    const topicRows = [...host.querySelectorAll<HTMLButtonElement>(".topics button")].filter(
      (button) => button.textContent.startsWith("#"),
    );
    expect(topicRows.length).toBeGreaterThan(0);
    for (const row of topicRows) {
      // A row is one frame: no outlined chip inside it.
      expect(row.querySelector(".shared-topic-chip")).toBeNull();
    }
    expect(topicRows.map((row) => row.textContent.replace(/\d+$/, ""))).toContain("#api");
    expect(host.querySelector(".group .shared-topic-chip")).not.toBeNull();
  });

  it("points the Questions row at its filters and leaves the page state to the children", async () => {
    const host = await render(null);
    await click(questionsRow(host));
    const group = host.querySelector(".questions-tree");
    expect(group?.id).toBeTruthy();
    expect(questionsRow(host)?.getAttribute("aria-controls")).toBe(group?.id);
    expect(questionsRow(host)?.hasAttribute("aria-pressed")).toBe(false);
  });

  it("offers no expander at all while every question is still unknown", async () => {
    const host = await render(null, true, false);
    await click(questionsRow(host));
    expect(host.querySelector(".questions-tree")).toBeNull();
    // No chevron (the tree-node class draws it) and no aria-expanded either.
    expect(questionsRow(host)?.hasAttribute("aria-expanded")).toBe(false);
    expect(questionsRow(host)?.classList.contains("tree-node")).toBe(false);
  });

  it("marks the Questions row as the current page unless a filter is chosen", async () => {
    const host = await render(null);
    expect(questionsRow(host)?.hasAttribute("aria-current")).toBe(false);
    await click(questionsRow(host));
    expect(questionsRow(host)?.getAttribute("aria-current")).toBe("page");
    await click(child(host, "carol-agent"));
    expect(questionsRow(host)?.hasAttribute("aria-current")).toBe(false);
    await click(host.querySelector(".question-filter button"));
    expect(questionsRow(host)?.getAttribute("aria-current")).toBe("page");
    // Another view takes the mark away.
    await click(
      [...host.querySelectorAll(".topics > button")].find((b) => b.textContent === "All"),
    );
    expect(questionsRow(host)?.hasAttribute("aria-current")).toBe(false);
  });
});

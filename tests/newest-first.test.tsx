// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { EMPTY_PREFERENCES } from "../src/identity/preferences";
import { AttachmentReader } from "../src/loader/attachments";
import { Loader } from "../src/loader/loader";
import type { Message } from "../src/message/types";
import { FixtureSource } from "../src/source/fixture";
import { FilesView } from "../src/ui/Attachments";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { buildPeople } from "../src/ui/people";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const id = (minute: number, from = "alice-agent") =>
  `2026-10-01T09${String(minute).padStart(2, "0")}-${from}-api-01`;
const files: Record<string, string> = {
  ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent, bob-agent, carol-agent\n",
};
const question = (minute: number, fields: Record<string, string> = {}) => {
  files[`inbox/${id(minute)}.md`] = messageText(id(minute), "alice-agent", "api", {
    type: "question",
    to: "carol-agent",
    needs: "answer",
    ...fields,
  });
};
// The viewer is bob. Open: 00 is OLD and waits for bob; 01 and 02 are newer but not for bob;
// 03 is the newest and overdue. Answered (bob replied): 10 and 11.
files[`inbox/${id(0, "carol-agent")}.md`] = messageText(
  id(0, "carol-agent"),
  "carol-agent",
  "api",
  {
    type: "question",
    to: "bob-agent",
    needs: "answer",
  },
);
question(1);
question(2);
question(3, { due: "2020-01-01" });
for (const minute of [10, 11]) {
  question(minute, { to: "bob-agent" });
  const reply = `2026-10-01T09${String(minute + 20)}-bob-agent-api-01`;
  files[`inbox/${reply}.md`] = messageText(reply, "bob-agent", "api", {
    type: "answer",
    to: "alice-agent",
    reply_to: id(minute),
  });
}

describe("Questions newest first", () => {
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

  async function render(): Promise<HTMLElement> {
    const loader = new Loader(new FixtureSource(files));
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
            selfNames={new Set(["bob-agent"])}
            identity={{ storage: null, key: "k" }}
            notice={null}
            onOpenSettings={() => undefined}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    return host;
  }
  async function click(element: Element | null | undefined) {
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }
  const order = (host: HTMLElement, group: string) =>
    [
      ...(host
        .querySelector(`section[aria-label="${group}"]`)
        ?.querySelectorAll(".question-text") ?? []),
    ].map((node) => node.textContent.match(/T09(\d\d)/)?.[1]);

  it("keeps the tiers, then lists the newest first, in every group", async () => {
    const host = await render();
    await click(
      [...host.querySelectorAll<HTMLButtonElement>(".topics > button")].find((button) =>
        button.textContent.startsWith("Questions"),
      ),
    );
    // Overdue first (03), then waiting for the viewer (00, though it is the oldest), then the
    // rest newest first (02, 01).
    expect(order(host, "Open")).toEqual(["03", "00", "02", "01"]);
    expect(order(host, "Answered")).toEqual(["11", "10"]);
  });

  it("keeps newest first inside a filter of the tree", async () => {
    const host = await render();
    await click(
      [...host.querySelectorAll<HTMLButtonElement>(".topics > button")].find((button) =>
        button.textContent.startsWith("Questions"),
      ),
    );
    await click(
      [...host.querySelectorAll<HTMLButtonElement>(".questions-tree button")].find((button) =>
        button.textContent.startsWith("Open"),
      ),
    );
    expect(order(host, "Open")).toEqual(["03", "00", "02", "01"]);
    await click(
      [...host.querySelectorAll<HTMLButtonElement>(".questions-tree button")].find((button) =>
        button.textContent.startsWith("carol-agent"),
      ),
    );
    // Carol owes 01, 02 and 03: newest first, overdue 03 leading.
    expect(order(host, "Open")).toEqual(["03", "02", "01"]);
  });
});

describe("Files newest first", () => {
  let mounted: { host: HTMLElement; root: Root } | null = null;
  afterEach(() => {
    if (mounted !== null) act(() => mounted?.root.unmount());
    mounted = null;
    document.body.replaceChildren();
  });

  const message = (index: number): Message => ({
    id: `message-${String(index).padStart(4, "0")}`,
    path: `inbox/message-${String(index).padStart(4, "0")}.md`,
    timestamp: "2026-10-01 09:00",
    from: "alice-agent",
    to: ["bob-agent"],
    topic: "api",
    type: "info",
    replyTo: null,
    replies: null,
    refs: [`topics/api/file-${String(index).padStart(4, "0")}.txt`],
    needs: null,
    due: null,
    body: { state: "plain", lines: ["text"] },
    issues: [],
  });

  it("lists the newest file first and loads older ones below", async () => {
    const messages = Array.from({ length: 450 }, (_, index) => message(index));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <FilesView
            messages={messages}
            context={{
              reader: new AttachmentReader(new FixtureSource({}), () => "fixture"),
              loadedIds: new Set(messages.map((m) => m.id)),
              onJump: () => undefined,
            }}
            people={buildPeople(["alice-agent", "bob-agent"], EMPTY_PREFERENCES)}
            selectedTopic={null}
            scope={null}
            onScopeChange={() => undefined}
            hasOlder={false}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    const names = () => [...host.querySelectorAll(".file-name")].map((node) => node.textContent);
    expect(names()).toHaveLength(200);
    expect(names()[0]).toContain("file-0449");
    expect(names()[199]).toContain("file-0250");
    await act(async () => {
      host
        .querySelector(".files-load-more")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    // The older files come after the ones already shown.
    expect(names()).toHaveLength(400);
    expect(names()[200]).toContain("file-0249");
    expect(names()[399]).toContain("file-0050");
  });
});

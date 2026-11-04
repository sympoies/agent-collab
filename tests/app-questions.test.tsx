// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MARKER = "collab-protocol: 1\nparticipants: alice-agent, bob-agent\n";
const id = (minute: number, from: string, topic = "api") =>
  `2026-10-01T09${String(minute).padStart(2, "0")}-${from}-${topic}-01`;

const OPEN = id(0, "alice-agent");
const ANSWERED = id(5, "alice-agent");
const CONCLUDED = id(10, "alice-agent", "ops");
const files: Record<string, string> = { ".agent-collab": MARKER };
function add(
  messageId: string,
  from: string,
  topic: string,
  type: string,
  fields: Record<string, string>,
  body: string,
) {
  files[`inbox/${messageId}.md`] = messageText(messageId, from, topic, { type, ...fields }, body);
}
add(OPEN, "alice-agent", "api", "question", { to: "bob-agent" }, "Is the schema final?");
add(
  id(1, "bob-agent"),
  "bob-agent",
  "api",
  "ack",
  { to: "alice-agent", reply_to: OPEN },
  "Received. Expected reply: within 10 minutes",
);
add(ANSWERED, "alice-agent", "api", "question", { to: "bob-agent" }, "Can the field be optional?");
add(
  id(6, "bob-agent"),
  "bob-agent",
  "api",
  "answer",
  { to: "alice-agent", reply_to: ANSWERED },
  "Yes.",
);
add(CONCLUDED, "alice-agent", "ops", "question", { to: "bob-agent" }, "Which region first?");
add(
  id(11, "bob-agent", "ops"),
  "bob-agent",
  "ops",
  "answer",
  { to: "alice-agent", reply_to: CONCLUDED },
  "North.",
);
add(
  id(12, "alice-agent", "ops"),
  "alice-agent",
  "ops",
  "info",
  { to: "all", reply_to: CONCLUDED },
  "We chose North.",
);
add(
  id(13, "bob-agent", "ops"),
  "bob-agent",
  "ops",
  "ack",
  { to: "alice-agent", reply_to: id(12, "alice-agent", "ops") },
  "",
);

describe("receipts and the Questions view", () => {
  let mounted: { host: HTMLElement; root: Root } | null = null;

  afterEach(() => {
    if (mounted !== null) {
      const { root } = mounted;
      act(() => {
        root.unmount();
      });
    }
    mounted = null;
    document.body.replaceChildren();
  });

  async function render(
    ownNames: readonly string[],
    repository: Record<string, string> = files,
  ): Promise<HTMLElement> {
    const loader = new Loader(new FixtureSource(repository));
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
            selfNames={new Set(ownNames)}
            identity={{ storage: null, key: "test" }}
            notice={null}
            onOpenSettings={() => undefined}
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
      await Promise.resolve();
    });
  }

  it("shows acknowledgements with their ETA under the message, not as rows", async () => {
    const host = await render([]);
    const question = host.querySelector(`#msg-${OPEN}`);
    expect(question?.textContent).toContain(
      "bob-agent acknowledged 09:01 · reply expected within 10 minutes",
    );
    expect(question?.textContent).toContain("0/1 answered");
    expect(host.querySelector(`#msg-${id(1, "bob-agent")}`)).toBeNull();
    // The recipient list states plainly that there is no read receipt.
    expect(question?.querySelector(".recipients")?.textContent).toContain(
      "bob-agent acknowledged 09:01",
    );
    expect(question?.querySelector(".recipients")?.textContent).toContain("no read receipt");
  });

  it("shows answered progress and the conclusion under the question", async () => {
    const host = await render([]);
    expect(host.querySelector(`#msg-${ANSWERED}`)?.textContent).toContain("1/1 answered");
    const concluded = host.querySelector(`#msg-${CONCLUDED}`);
    expect(concluded?.querySelector(".conclusion")?.textContent).toContain("We chose North.");
    // An acknowledgement with an empty body still counts as a receipt, not a row.
    expect(host.querySelector(`#msg-${id(13, "bob-agent", "ops")}`)).toBeNull();
    expect(host.querySelector(`#msg-${id(12, "alice-agent", "ops")}`)?.textContent).toContain(
      "bob-agent acknowledged 09:13",
    );
  });

  it("groups questions by state and marks the ones waiting for the viewer", async () => {
    const host = await render(["bob-agent"]);
    expect(button(host, "Questions")?.textContent).toContain("1 open");
    await click(button(host, "Questions"));
    const group = (name: string) =>
      [...host.querySelectorAll(`section[aria-label="${name}"] .question-text`)].map(
        (node) => node.textContent,
      );
    expect(group("Open")).toEqual(["Is the schema final?"]);
    expect(group("Answered")).toEqual(["Can the field be optional?"]);
    expect(group("Concluded")).toEqual(["Which region first?"]);
    expect(host.querySelector('section[aria-label="Open"] .you')?.textContent).toBe(
      "Waiting for you",
    );
    expect(host.querySelector("#conversation-heading")?.textContent).toBe("Questions");
  });

  it("opens a question in its conversation", async () => {
    const host = await render([]);
    await click(button(host, "Questions"));
    await click(host.querySelector('section[aria-label="Concluded"] .question-link') ?? undefined);
    expect(host.querySelector("#conversation-heading")?.textContent).toBe("#ops");
    expect(host.querySelector(`#msg-${CONCLUDED}`)).not.toBeNull();
    expect(host.querySelector(`#msg-${OPEN}`)).toBeNull();
  });

  it("keeps an acknowledgement with its own text as a readable row", async () => {
    const wordy = id(2, "bob-agent");
    const repository = {
      ...files,
      [`inbox/${wordy}.md`]: messageText(
        wordy,
        "bob-agent",
        "api",
        { type: "ack", to: "alice-agent", reply_to: OPEN },
        "Looking into it. Blocked on the schema review.",
      ),
    };
    const host = await render([], repository);
    expect(host.querySelector(`#msg-${wordy}`)?.textContent).toContain(
      "Looking into it. Blocked on the schema review.",
    );
    // The plain ack stays a receipt line, and the later wordy ack decides the recipient state.
    expect(host.querySelector(`#msg-${id(1, "bob-agent")}`)).toBeNull();
    expect(host.querySelector(`#msg-${OPEN} .recipients`)?.textContent).toContain(
      "bob-agent acknowledged 09:02",
    );
  });
});

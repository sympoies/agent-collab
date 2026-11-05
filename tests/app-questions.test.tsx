// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { questionExpansionStorageKey } from "../src/ui/question-expansion";
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
    window.localStorage.removeItem(questionExpansionStorageKey("test"));
  });

  async function render(
    ownNames: readonly string[],
    repository: Record<string, string> = files,
    identityKey = "test",
    storage: Storage | null = null,
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
            identity={{ storage, key: identityKey }}
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

  it("omits the Needs line when needs is none but keeps an actual request", async () => {
    const needsId = id(20, "alice-agent", "ops");
    const repository = {
      ...files,
      [`inbox/${needsId}.md`]: messageText(
        needsId,
        "alice-agent",
        "ops",
        { type: "question", to: "bob-agent", needs: "schema review" },
        "A question with a requested action.",
      ),
    };
    const host = await render([], repository);
    await click(button(host, "Questions"));

    expect(host.querySelector(`#question-${OPEN} .question-needs`)).toBeNull();
    expect(host.querySelector(`#question-${needsId} .question-needs`)?.textContent).toContain(
      "schema review",
    );
  });

  it("keeps question disclosure choices in the session when browser storage is unavailable", async () => {
    const previous = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
        setItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      },
    });
    try {
      const host = await render([], files, "test", window.localStorage);
      await click(button(host, "Questions"));
      const answered = host.querySelector<HTMLElement>(
        'section[aria-label="Answered"] .question-toggle',
      );
      expect(answered?.getAttribute("aria-expanded")).toBe("false");
      expect(answered?.parentElement?.querySelector(".question-body")).toBeNull();
      await click(answered ?? undefined);
      expect(answered?.getAttribute("aria-expanded")).toBe("true");
      expect(answered?.parentElement?.querySelector(".question-body")).not.toBeNull();
      await click(button(host, "Files"));
      await click(button(host, "Questions"));
      expect(
        host
          .querySelector('section[aria-label="Answered"] .question-toggle')
          ?.getAttribute("aria-expanded"),
      ).toBe("true");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(window, "localStorage");
      else Object.defineProperty(window, "localStorage", previous);
    }
  });

  it("remembers a question disclosure choice in browser storage", async () => {
    const host = await render([], files, "test", window.localStorage);
    await click(button(host, "Questions"));
    const answered = host.querySelector<HTMLElement>(
      'section[aria-label="Answered"] .question-toggle',
    );
    await click(answered ?? undefined);
    expect(
      JSON.parse(window.localStorage.getItem(questionExpansionStorageKey("test")) ?? "{}"),
    ).toMatchObject({ [ANSWERED]: true });
  });

  it("restores a disclosure choice after remounting the viewer", async () => {
    const host = await render([], files, "test", window.localStorage);
    await click(button(host, "Questions"));
    await click(host.querySelector('section[aria-label="Answered"] .question-toggle') ?? undefined);
    const root = mounted?.root;
    expect(root).toBeDefined();
    act(() => {
      root?.unmount();
    });
    mounted = null;

    const restored = await render([], files, "test", window.localStorage);
    await click(button(restored, "Questions"));
    expect(
      restored
        .querySelector('section[aria-label="Answered"] .question-toggle')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("does not restore disclosure choices from another repository", async () => {
    const host = await render([], files, "test", window.localStorage);
    await click(button(host, "Questions"));
    await click(host.querySelector('section[aria-label="Answered"] .question-toggle') ?? undefined);
    const root = mounted?.root;
    act(() => root?.unmount());
    mounted = null;

    const other = await render([], files, "other-repository", window.localStorage);
    await click(button(other, "Questions"));
    expect(
      other
        .querySelector('section[aria-label="Answered"] .question-toggle')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("opens a question in its conversation", async () => {
    const host = await render([]);
    await click(button(host, "Questions"));
    await click(
      host.querySelector('section[aria-label="Concluded"] .question-open-chat') ?? undefined,
    );
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

  describe("answers, overdue and waiting time", () => {
    const THREE = "collab-protocol: 1\nparticipants: alice-agent, bob-agent, carol-agent\n";
    const ASKED = id(0, "alice-agent", "ship");
    const QUIET = id(2, "alice-agent", "ship");
    const DONE = id(3, "alice-agent", "ship");
    const ACK = id(1, "bob-agent", "ship");
    const ANSWER = id(5, "bob-agent", "ship");
    const REMINDER = id(10, "alice-agent", "ship");
    const repository: Record<string, string> = { ".agent-collab": THREE };
    const put = (
      messageId: string,
      from: string,
      type: string,
      fields: Record<string, string>,
      body: string,
    ) => {
      repository[`inbox/${messageId}.md`] = messageText(
        messageId,
        from,
        "ship",
        { type, ...fields },
        body,
      );
    };
    put(
      ASKED,
      "alice-agent",
      "question",
      { to: "bob-agent, carol-agent", due: "2026-09-30" },
      "Ship it?",
    );
    put(
      ACK,
      "bob-agent",
      "ack",
      { to: "alice-agent", reply_to: ASKED },
      "Received. Expected reply: within 10 minutes",
    );
    put(
      ANSWER,
      "bob-agent",
      "answer",
      { to: "alice-agent", reply_to: ASKED },
      "Yes, ship.\nAfter the freeze.\nCheck the docs.\nFourth line stays hidden.",
    );
    put(
      REMINDER,
      "alice-agent",
      "info",
      { to: "carol-agent", reply_to: ASKED },
      "Carol, please answer.",
    );
    put(QUIET, "alice-agent", "question", { to: "carol-agent" }, "Any objection?");
    put(DONE, "alice-agent", "question", { to: "bob-agent" }, "Is it done?");
    put(
      id(4, "bob-agent", "ship"),
      "bob-agent",
      "answer",
      { to: "alice-agent", reply_to: DONE },
      "Done.",
    );
    // Only carol answers, and she is not an addressee, so the question stays open.
    const OUTSIDE = id(6, "alice-agent", "ship");
    put(OUTSIDE, "alice-agent", "question", { to: "bob-agent" }, "Who owns this?");
    put(
      id(7, "carol-agent", "ship"),
      "carol-agent",
      "answer",
      { to: "alice-agent", reply_to: OUTSIDE },
      "I do.",
    );
    // Asked today, so it has waited less than a day.
    put(
      "2026-10-04T0900-alice-agent-ship-01",
      "alice-agent",
      "question",
      { to: "carol-agent" },
      "Fresh one?",
    );
    // Seven replies: the list shows the newest five and a button for the rest.
    const BUSY = id(20, "alice-agent", "ship");
    put(
      BUSY,
      "alice-agent",
      "question",
      { to: "bob-agent, carol-agent", replies: "any" },
      "Busy one?",
    );
    for (let n = 1; n <= 6; n += 1) {
      put(
        id(20 + n, "alice-agent", "ship"),
        "alice-agent",
        "info",
        { to: "carol-agent", reply_to: BUSY },
        `Nudge ${String(n)}.`,
      );
    }
    put(
      id(30, "bob-agent", "ship"),
      "bob-agent",
      "answer",
      { to: "alice-agent", reply_to: BUSY },
      "Handled.",
    );

    async function open(): Promise<HTMLElement> {
      // 2026-10-04 11:10 local: the first question is 3 days old and past its due date.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 4, 11, 10));
      const host = await render([], repository);
      await click(button(host, "Questions"));
      return host;
    }
    const item = (host: HTMLElement, text: string) =>
      [...host.querySelectorAll(".question-item")].find((node) => node.textContent.includes(text));
    const expand = async (question: Element | undefined) => {
      const toggle = question?.querySelector<HTMLButtonElement>(".question-toggle");
      if (toggle?.getAttribute("aria-expanded") === "false") await click(toggle);
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows the replies under each question, newest-last, as links to the full message", async () => {
      const host = await open();
      const asked = item(host, "Ship it?");
      await expand(asked);
      const replies = [...(asked?.querySelectorAll(".question-reply") ?? [])];
      expect(replies.map((reply) => reply.getAttribute("data-kind"))).toEqual([
        "answer",
        "reminder",
      ]);
      const [answer, reminder] = replies;
      expect(answer?.textContent).toContain("bob-agent");
      expect(answer?.textContent).toContain("09:05");
      expect(answer?.textContent).toContain("answer");
      expect(answer?.textContent).toContain("Yes, ship.");
      expect(answer?.textContent).toContain("Check the docs.");
      expect(answer?.textContent).not.toContain("Fourth line");
      expect(reminder?.textContent).toContain("reminder");
      expect(reminder?.textContent).toContain("Carol, please answer.");
      // Acknowledgements without text are one compact line, not a card.
      expect(asked?.querySelector(".question-ack")?.textContent).toBe(
        "bob-agent acknowledged 2026-10-01 09:01 · reply expected within 10 minutes",
      );
      await click(answer?.querySelector("button") ?? undefined);
      expect(host.querySelector("#conversation-heading")?.textContent).toBe("#ship");
      expect(host.querySelector(`#msg-${ANSWER}`)).not.toBeNull();
    });

    it("shows the overdue badge and the reminder count on a partly answered question, without a waiting time", async () => {
      const host = await open();
      const asked = item(host, "Ship it?");
      expect(asked?.querySelector(".shared-overdue")?.textContent).toBe("Overdue · due 2026-09-30");
      expect(asked?.querySelector(".reminder-count")?.textContent).toBe(
        "1 reminder, last 2026-10-01 09:10",
      );
      // It has an answer, so it is not "unanswered" even though it needs more.
      expect(asked?.textContent).toContain("1/2 answered");
      expect(asked?.querySelector(".question-waiting")).toBeNull();
    });

    it("shows no waiting time when the only answer comes from someone not counted", async () => {
      const host = await open();
      const outside = item(host, "Who owns this?");
      await expand(outside);
      expect(outside?.closest("section")?.getAttribute("aria-label")).toBe("Open");
      expect(outside?.textContent).toContain("0/1 answered");
      expect(outside?.querySelector(".question-reply")?.textContent).toContain("I do.");
      expect(outside?.querySelector(".question-waiting")).toBeNull();
    });

    it("shows waiting time in whole days, and none under a day, but no overdue badge without a due date", async () => {
      const host = await open();
      const quiet = item(host, "Any objection?");
      expect(quiet?.querySelector(".question-waiting")?.textContent).toBe("Unanswered for 3 days");
      expect(quiet?.querySelector(".shared-overdue")).toBeNull();
      const fresh = item(host, "Fresh one?");
      expect(fresh?.closest("section")?.getAttribute("aria-label")).toBe("Open");
      expect(fresh?.querySelector(".question-waiting")).toBeNull();
    });

    it("lists the newest five replies and a button that shows all of them", async () => {
      const host = await open();
      const busy = item(host, "Busy one?");
      await expand(busy);
      const texts = () =>
        [...(busy?.querySelectorAll(".reply-text") ?? [])].map((node) => node.textContent);
      // Newest last: replies 3 to 6 and the answer.
      expect(texts()).toEqual(["Nudge 3.", "Nudge 4.", "Nudge 5.", "Nudge 6.", "Handled."]);
      const more = busy?.querySelector<HTMLButtonElement>("button.replies-toggle");
      expect(more?.textContent).toBe("Show all 7 replies");
      expect(more?.getAttribute("aria-expanded")).toBe("false");
      await click(more ?? undefined);
      expect(texts()).toHaveLength(7);
      expect(texts()[0]).toBe("Nudge 1.");
      // The same button stays, now offering to collapse.
      expect(busy?.querySelector("button.replies-toggle")).toBe(more);
      expect(more?.getAttribute("aria-expanded")).toBe("true");
      expect(more?.textContent).toBe("Show fewer replies");
      // Few replies need no button.
      expect(item(host, "Ship it?")?.querySelector("button.replies-toggle")).toBeNull();
    });

    it("shows neither badge once a question is answered", async () => {
      const host = await open();
      const done = item(host, "Is it done?");
      await expand(done);
      expect(done?.closest("section")?.getAttribute("aria-label")).toBe("Answered");
      expect(done?.querySelector(".question-waiting")).toBeNull();
      expect(done?.querySelector(".shared-overdue")).toBeNull();
      expect(done?.querySelector(".question-reply")?.textContent).toContain("Done.");
    });
  });
});

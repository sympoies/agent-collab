// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { AttachmentReader } from "../src/loader/attachments";
import type { Message } from "../src/message/types";
import { FixtureSource } from "../src/source/fixture";
import { FilesView } from "../src/ui/Attachments";
import { EMPTY_PREFERENCES } from "../src/identity/preferences";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { buildPeople } from "../src/ui/people";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("the Files view keeps large lists bounded", () => {
  let mounted: { host: HTMLElement; root: Root } | null = null;

  afterEach(() => {
    if (mounted !== null) act(() => mounted?.root.unmount());
    mounted = null;
    document.body.replaceChildren();
  });

  it("does not mount expanded message bodies and keeps excerpts within 280 characters", async () => {
    const fullBody = "FULL_MESSAGE_BODY_" + "x".repeat(600);
    const messages: Message[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `message-${String(index).padStart(5, "0")}`,
      path: `inbox/message-${String(index).padStart(5, "0")}.md`,
      timestamp: "2026-10-01 09:00",
      from: "alice-agent",
      to: ["bob-agent"],
      topic: "api",
      type: "info",
      replyTo: null,
      replies: null,
      refs: [`topics/api/file-${String(index).padStart(5, "0")}.txt`],
      needs: null,
      due: null,
      body: { state: "plain", lines: [fullBody] },
      issues: [],
    }));
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
              loadedIds: new Set(messages.map((message) => message.id)),
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

    expect(host.querySelector(".file-full-message p")).toBeNull();
    expect(host.textContent).not.toContain(fullBody);
    expect(host.querySelectorAll(".file-item")).toHaveLength(200);
    expect(host.querySelectorAll("*").length).toBeLessThan(10_000);
    const excerpt = host.querySelector(".file-excerpt");
    expect(excerpt).not.toBeNull();
    expect((excerpt?.textContent ?? "").length).toBeLessThanOrEqual(280);

    const loadMore = host.querySelector<HTMLButtonElement>(".files-load-more");
    expect(loadMore).not.toBeNull();
    await act(async () => {
      loadMore?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelectorAll(".file-item")).toHaveLength(400);

    const fullMessage = host.querySelector<HTMLDetailsElement>(".file-full-message");
    await act(async () => {
      if (fullMessage !== null) fullMessage.open = true;
      fullMessage?.dispatchEvent(new Event("toggle"));
      await Promise.resolve();
    });
    expect(host.querySelector(".file-full-message p")?.textContent).toBe(fullBody);
  }, 60_000);
});

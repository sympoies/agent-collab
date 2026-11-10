// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../src/i18n/LocaleProvider";
import type { TopicSummary } from "../src/message/topic-layout";
import { TopicList } from "../src/ui/TopicList";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const topics: TopicSummary[] = Array.from({ length: 14 }, (_, index) => ({
  name: `topic-${String(index + 1).padStart(2, "0")}`,
  title: index === 2 ? "Needle in the title" : null,
  status: "open",
  folder: true,
}));

describe("topic list search", () => {
  let mounted: { host: HTMLElement; root: Root } | null = null;

  afterEach(() => {
    if (mounted !== null) act(() => mounted?.root.unmount());
    mounted = null;
    document.body.replaceChildren();
  });

  function render(
    summaries: readonly TopicSummary[],
    options: {
      loaded?: ReadonlySet<string>;
      selected?: string | null;
      pinned?: ReadonlySet<string>;
      onLoadAll?: () => void;
    } = {},
  ) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    act(() => {
      root.render(
        <LocaleProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <TopicList
            topics={summaries}
            loadedTopics={options.loaded ?? new Set(summaries.map((topic) => topic.name))}
            {...(options.pinned === undefined ? {} : { pinnedTopics: options.pinned })}
            onLoadAll={options.onLoadAll ?? (() => undefined)}
            selected={options.selected ?? null}
            pressed={null}
            closedOpen={false}
            onClosedOpenChange={() => undefined}
            onSelect={() => undefined}
          />
        </LocaleProvider>,
      );
    });
    return host;
  }

  function enterQuery(host: HTMLElement, query: string) {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();
    act(() => {
      if (input === null) return;
      // Use the native setter so React observes the value change in its synthetic input event.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter !== undefined) setter.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }

  it("hides the filter at twelve topics and exposes a labelled search above the limit", () => {
    const small = render(topics.slice(0, 12));
    expect(small.querySelector('input[type="search"]')).toBeNull();

    const large = render(topics);
    expect(large.querySelector('input[type="search"]')?.getAttribute("aria-label")).toBe(
      "Search topics",
    );
  });

  it("matches names and titles without case sensitivity and keeps selected and pinned rows", () => {
    const host = render(topics, {
      selected: "topic-01",
      pinned: new Set(["topic-02"]),
    });
    enterQuery(host, "NEEDLE");
    const visible = [...host.querySelectorAll("button .topic-name")].map(
      (node) => node.textContent,
    );
    expect(visible).toEqual(["#topic-01", "#topic-02", "#topic-03"]);
  });

  it("states which loaded topics are searchable and requests the rest", () => {
    const onLoadAll = vi.fn();
    const host = render(topics, {
      loaded: new Set(["topic-01"]),
      selected: "topic-01",
      onLoadAll,
    });
    expect(host.textContent).toContain("Search scope: 1/14 topics loaded.");
    expect(host.textContent).toContain("13 topics are not loaded yet");
    expect(host.querySelector('[aria-label="Search topics"]')).not.toBeNull();

    act(() => {
      host.querySelector<HTMLButtonElement>(".topic-search-unloaded button")?.click();
    });
    expect(onLoadAll).toHaveBeenCalledOnce();

    const input = enterQuery(host, "no-match");
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(input?.value).toBe("");
  });
});

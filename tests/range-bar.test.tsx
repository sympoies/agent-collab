// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { App } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { MARKER, messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const OLD = "2026-08-15T0900-alice-agent-api-01";
const MID = "2026-09-20T0900-bob-agent-api-01";
const NEW = "2026-10-02T0900-bob-agent-api-01";
const FILES = {
  ".agent-collab": `${MARKER}participants: alice-agent, bob-agent\n`,
  [`inbox/2026-08/${OLD}.md`]: messageText(OLD, "alice-agent", "api", { type: "question" }),
  [`inbox/2026-09/${MID}.md`]: messageText(MID, "bob-agent", "api"),
  // The newest message answers a question that is older than the loaded page.
  [`inbox/2026-10/${NEW}.md`]: messageText(NEW, "bob-agent", "api", {
    type: "answer",
    reply_to: OLD,
  }),
};

const TEXTS = {
  en: {
    loaded: "Loaded 1 message, back to 2026-10-02",
    past: "Loaded 1 message from 2026-08-15 to 2026-08-15. Newer messages are not loaded.",
    jump: "Jump to date",
    go: "Go",
    newest: "Show newest messages",
    none: "No messages on or before 2026-01-01. Newer messages are not loaded.",
    earlier: `Reply to ${OLD} (the original is earlier)`,
  },
  ja: {
    loaded: "1件のメッセージを読み込み済み（2026-10-02まで）",
    past: "2026-08-15から2026-08-15までの1件を読み込み済み。これより新しいメッセージは読み込まれていません。",
    jump: "日付へ移動",
    go: "移動",
    newest: "最新のメッセージを表示",
    none: "2026-01-01以前のメッセージはありません。これより新しいメッセージは読み込まれていません。",
    earlier: `${OLD} への返信（元のメッセージはさらに前にあります）`,
  },
  "zh-TW": {
    loaded: "已載入 1 則訊息，最早到 2026-10-02",
    past: "已載入 2026-08-15 至 2026-08-15 的 1 則訊息，較新的訊息尚未載入。",
    jump: "跳到日期",
    go: "前往",
    newest: "顯示最新訊息",
    none: "2026-01-01 以前沒有訊息，較新的訊息尚未載入。",
    earlier: `回覆 ${OLD}（原訊息較早）`,
  },
} as const;

describe("the loaded range line, the jump to a date and a reply whose original is earlier", () => {
  let mounted: Root | null = null;
  afterEach(() => {
    act(() => {
      mounted?.unmount();
    });
    mounted = null;
    document.body.replaceChildren();
  });

  async function open(locale: keyof typeof TEXTS, source = new FixtureSource(FILES), pageSize = 1) {
    const loader = new Loader(source, { pageSize });
    const host = document.createElement("div");
    document.body.append(host);
    mounted = createRoot(host);
    await act(async () => {
      mounted?.render(
        <LocaleProvider storage={{ getItem: () => locale, setItem: () => undefined }}>
          <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
            <App
              loader={loader}
              title="Fixture"
              selfNames={new Set()}
              identity={{ storage: null, key: "test" }}
              notice={null}
              pollIntervalMs={3_600_000}
              onOpenSettings={() => undefined}
            />
          </ThemeProvider>
        </LocaleProvider>,
      );
      await loader.open();
    });
    return { host, source };
  }

  const settle = () =>
    act(async () => {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    });

  const jumpTo = async (host: HTMLElement, day: string) => {
    const input = host.querySelector<HTMLInputElement>('.range-jump input[type="date"]');
    // Setting the value and submitting the form is what Enter in the field does.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(input, day);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      host
        .querySelector(".range-jump")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
  };

  const click = (element: Element | null | undefined) => {
    act(() => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  const button = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

  for (const locale of ["en", "ja", "zh-TW"] as const) {
    const text = TEXTS[locale];

    it(`says how far back messages are loaded and jumps by keyboard in ${locale}`, async () => {
      const { host, source } = await open(locale);
      expect(host.querySelector(".range-line")?.textContent).toBe(text.loaded);
      expect(host.querySelectorAll("h1")).toHaveLength(1);

      const input = host.querySelector<HTMLInputElement>('.range-jump input[type="date"]');
      expect(input?.closest("label")?.textContent).toBe(text.jump);
      expect(button(host, text.go)?.disabled).toBe(true);
      expect(button(host, text.newest)).toBeUndefined();

      source.listings.length = 0;
      await jumpTo(host, "2026-08-20");
      expect(source.listings).toEqual(["inbox/2026-08"]);
      expect(host.querySelector(".range-line")?.textContent).toBe(text.past);
      expect(host.querySelectorAll("h1")).toHaveLength(1);
      // The question in the range may have been answered in the part that is not loaded.
      expect(host.querySelector('.question-progress[data-state="unknown"]')).not.toBeNull();
      expect(document.activeElement).toBe(input);

      await jumpTo(host, "2026-01-01");
      expect(host.querySelectorAll(".message")).toHaveLength(0);
      expect(host.querySelector(".range-line")?.textContent).toBe(text.none);

      click(button(host, text.newest));
      await settle();
      expect(host.querySelector(".range-line")?.textContent).toBe(text.loaded);
      expect(button(host, text.newest)).toBeUndefined();
      // The button the reader pressed is gone; focus is on the date field, not on the page.
      expect(document.activeElement).toBe(input);
    });

    it(`offers to load an older original instead of calling it missing in ${locale}`, async () => {
      const { host } = await open(locale);
      const quote = host.querySelector(".quote.missing");
      expect(quote?.textContent).toContain(text.earlier);
      expect(quote?.querySelector("code")?.textContent).toBe(OLD);
      const load = quote?.querySelector("button");
      expect(load).toBeTruthy();
      click(load);
      await settle();
      // One page later the middle message is loaded, but the original is still older: still offered.
      expect(host.querySelectorAll(".message")).toHaveLength(2);
      expect(host.querySelector(".quote.missing button")).toBeTruthy();
      click(host.querySelector(".quote.missing button"));
      await settle();
      expect(host.querySelector(".quote.missing")).toBeNull();
      expect(host.querySelector(".quote")?.getAttribute("href")).toBe(`#msg-${OLD}`);
    });
  }

  it("does not jump to a date that is not a four-digit year", async () => {
    const { host, source } = await open("en");
    source.listings.length = 0;
    await jumpTo(host, "10000-01-01");
    expect(source.listings).toEqual([]);
    expect(host.querySelector(".range-line")?.textContent).toBe(TEXTS.en.loaded);
  });

  it("calls a reply's original not shown once nothing older can be loaded", async () => {
    const lonely = {
      ...FILES,
      [`inbox/2026-10/${NEW}.md`]: messageText(NEW, "bob-agent", "api", {
        type: "answer",
        reply_to: "2026-01-01T0900-alice-agent-api-01",
      }),
    };
    const { host } = await open("en", new FixtureSource(lonely), 50);
    expect(host.querySelector(".quote.missing")?.textContent).toContain("(parent not shown)");
    expect(host.querySelector(".quote.missing button")).toBeNull();
  });
});

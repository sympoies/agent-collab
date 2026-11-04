// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IconButton } from "../src/ui/IconButton";
import { MenuItem, OverflowMenu } from "../src/ui/OverflowMenu";
import { MoreIcon, RefreshIcon } from "../src/ui/icons";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("icon buttons and the overflow menu", () => {
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

  async function render(node: React.ReactNode): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(node);
      await Promise.resolve();
    });
    return host;
  }

  const key = async (target: Element | null, name: string) => {
    await act(async () => {
      target?.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
  };
  const click = async (target: Element | null) => {
    await act(async () => {
      target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  };

  it("is a native button named by its label, with the same text as tooltip, and a hidden glyph", async () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    const host = await render(
      <IconButton ref={ref} label="Refresh" aria-pressed={true} onClick={onClick}>
        <RefreshIcon />
      </IconButton>,
    );
    const button = host.querySelector("button");
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("aria-label")).toBe("Refresh");
    expect(button?.getAttribute("title")).toBe("Refresh");
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    expect(button?.textContent).toBe("");
    const glyph = host.querySelector("svg");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(glyph?.getAttribute("stroke")).toBe("currentColor");
    expect(ref.current).toBe(button);
    await click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  function menu(onSelect: () => void = () => undefined) {
    return (
      <>
        <button type="button">before</button>
        <OverflowMenu label="More">
          <MenuItem icon={<MoreIcon />} onSelect={onSelect}>
            One
          </MenuItem>
          <MenuItem onSelect={() => undefined}>Two</MenuItem>
          <MenuItem role="menuitemradio" checked={true} onSelect={() => undefined}>
            Three
          </MenuItem>
        </OverflowMenu>
      </>
    );
  }
  const trigger = (host: HTMLElement) =>
    host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  const items = (host: HTMLElement) => [
    ...host.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ];

  it("exposes menu semantics and moves focus into the menu when opened", async () => {
    const host = await render(menu());
    const opener = trigger(host);
    expect(opener?.getAttribute("aria-label")).toBe("More");
    expect(opener?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[role="menu"]')).toBeNull();
    await click(opener);
    expect(opener?.getAttribute("aria-expanded")).toBe("true");
    const popup = host.querySelector('[role="menu"]');
    expect(popup?.getAttribute("aria-label")).toBe("More");
    expect(opener?.getAttribute("aria-controls")).toBe(popup?.id);
    expect(items(host).map((item) => item.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
      "menuitemradio",
    ]);
    expect(items(host)[2]?.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(items(host)[0]);
  });

  it("moves with the arrow keys, wrapping, and with Home and End", async () => {
    const host = await render(menu());
    await click(trigger(host));
    const popup = host.querySelector('[role="menu"]');
    await key(popup, "ArrowDown");
    expect(document.activeElement).toBe(items(host)[1]);
    await key(popup, "End");
    expect(document.activeElement).toBe(items(host)[2]);
    await key(popup, "ArrowDown");
    expect(document.activeElement).toBe(items(host)[0]);
    await key(popup, "ArrowUp");
    expect(document.activeElement).toBe(items(host)[2]);
    await key(popup, "Home");
    expect(document.activeElement).toBe(items(host)[0]);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const host = await render(menu());
    await click(trigger(host));
    await key(host.querySelector('[role="menu"]'), "Escape");
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(trigger(host)?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger(host));
  });

  it("runs an item, closes and returns focus to the trigger", async () => {
    const onSelect = vi.fn();
    const host = await render(menu(onSelect));
    await click(trigger(host));
    await click(items(host)[0] ?? null);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger(host));
  });

  it("closes on a click outside, without taking focus back, and on Tab", async () => {
    const host = await render(menu());
    await click(trigger(host));
    await act(async () => {
      host.querySelector("button")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector('[role="menu"]')).toBeNull();

    await click(trigger(host));
    await key(host.querySelector('[role="menu"]'), "Tab");
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens from the trigger with the Down arrow key", async () => {
    const host = await render(menu());
    await key(trigger(host), "ArrowDown");
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement).toBe(items(host)[0]);
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/credentials/store";
import * as liveDemo from "../src/settings/live-demo";
import type { MessageSource } from "../src/source/types";
import { Root } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  window.history.replaceState(null, "", "/");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("returns to the welcome screen with an error when opening the demo fails", async () => {
  window.history.replaceState(null, "", "/?demo");
  vi.spyOn(liveDemo, "openLiveDemo").mockRejectedValue(new Error("failed"));
  const storage = { getItem: () => null, setItem: () => undefined };
  const source = {} as MessageSource;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ThemeProvider storage={storage}>
        <Root
          storage={storage}
          stores={{ memory: new MemoryStore(), "browser-encrypted": new MemoryStore() }}
          createSource={() => source}
          createDemoSource={() => source}
          createLiveDemoSource={() => source}
          openLocalFolder={null}
        />
      </ThemeProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("Open live demo");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  act(() => {
    root.unmount();
  });
});

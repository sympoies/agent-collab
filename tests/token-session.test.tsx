// @vitest-environment happy-dom

// The demo's session token: it follows Remove and replacement exactly, goes only to the API host,
// and is never stored or shown.

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryStore } from "../src/credentials/store";
import { Secret } from "../src/credentials/secret";
import { formatDateTime } from "../src/i18n/translate";
import { GitHubSource } from "../src/source/github";
import { FixtureSource } from "../src/source/fixture";
import { SourceError, type Head, type MessageSource } from "../src/source/types";
import { Root } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ID = "2026-11-03T0900-alice-agent-api-01";
const GENERATED = "2026-11-03T08:00:00.000Z";
const FILES = {
  ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent\n",
  [`inbox/${ID}.md`]: messageText(ID, "alice-agent", "api", {}, "Live copy message."),
};
const SNAPSHOT = {
  schemaVersion: 1,
  generatedAt: GENERATED,
  revision: "snapshot-tree",
  files: [
    { path: ".agent-collab", text: FILES[".agent-collab"] },
    {
      path: `inbox/${ID}.md`,
      text: messageText(ID, "alice-agent", "api", {}, "Snapshot message."),
    },
  ],
};
const SECRET_A = "test-token-a-not-real";
const SECRET_B = "test-token-b-not-real";

type Plain = Pick<Storage, "getItem" | "setItem">;

function plainStorage() {
  const values = new Map<string, string>();
  const storage: Plain = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { values, storage };
}

describe("the demo session token", () => {
  let mounted: { host: HTMLElement; root: ReactRoot } | null = null;

  afterEach(() => {
    if (mounted !== null) {
      const { root } = mounted;
      act(() => {
        root.unmount();
      });
    }
    mounted = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  function stubSnapshot() {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(SNAPSHOT), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
  }

  /** A live source whose head request waits for `release`; other requests read FILES. */
  function deferredSource() {
    const inner = new FixtureSource(FILES);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source: MessageSource = {
      head: async (previous): Promise<Head | "not-modified"> => {
        await gate;
        return inner.head(previous);
      },
      listDirectory: (revision, path) => inner.listDirectory(revision, path),
      readFile: (entry) => inner.readFile(entry),
      rateLimit: () => null,
    };
    return {
      source,
      release: () => {
        release();
      },
    };
  }

  async function mountRoot(options: {
    createLiveDemoSource: (token: Secret | null) => MessageSource;
    storage?: Plain;
    stores?: { memory: MemoryStore; "browser-encrypted": MemoryStore };
  }) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    const fixture = new FixtureSource(FILES);
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <Root
            storage={options.storage ?? plainStorage().storage}
            stores={
              options.stores ?? {
                memory: new MemoryStore(),
                "browser-encrypted": new MemoryStore(),
              }
            }
            createSource={() => fixture}
            createDemoSource={() => fixture}
            createLiveDemoSource={options.createLiveDemoSource}
            openLocalFolder={null}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    return host;
  }

  const press = async (host: HTMLElement, label: string, byAria = false) => {
    const target = [...host.querySelectorAll("button")].find(
      (candidate) =>
        (byAria ? candidate.getAttribute("aria-label") : candidate.textContent) === label,
    );
    expect(target, label).toBeDefined();
    await act(async () => {
      target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  async function saveToken(host: HTMLElement, secret: string, encrypted = false) {
    const field = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(field).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field,
        secret,
      );
      field?.dispatchEvent(new Event("input", { bubbles: true }));
      if (encrypted) {
        host
          .querySelectorAll<HTMLInputElement>('input[name="credentialStorage"]')[1]
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      await Promise.resolve();
    });
    await act(async () => {
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** Fills the demo repository into the Settings screen that is showing. */
  async function fillRepository(host: HTMLElement) {
    const repository = host.querySelector<HTMLInputElement>(
      'input[placeholder="owner/repository"]',
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        repository,
        "sympoies/agent-collab-demo",
      );
      repository?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  }

  /** Welcome, then Settings with the demo repository, ready to save a token. */
  async function openTokenSettings(host: HTMLElement) {
    await press(host, "Open another repository");
    await fillRepository(host);
  }

  const snapshotBanner = `Showing the snapshot generated at ${formatDateTime("en", new Date(GENERATED))}.`;

  it("drops a check that was running when the token was removed", async () => {
    stubSnapshot();
    const sources: { token: Secret | null; deferred?: ReturnType<typeof deferredSource> }[] = [];
    const host = await mountRoot({
      createLiveDemoSource: (token) => {
        const entry: (typeof sources)[number] = { token };
        // Only the check under the token waits; later sources answer at once.
        if (sources.length === 0 && token !== null) entry.deferred = deferredSource();
        sources.push(entry);
        return entry.deferred?.source ?? new FixtureSource(FILES);
      },
    });
    await openTokenSettings(host);
    await saveToken(host, SECRET_A);
    await press(host, "Settings", true);
    await press(host, "Open live demo");
    expect(host.textContent).toContain("Snapshot message.");

    // A check starts under the token and is still waiting when the credentials are removed.
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "Check live now")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(sources).toHaveLength(1);
    await press(host, "Settings", true);
    await press(host, "Remove stored credentials");
    // Resolve the waiting check: its result must be dropped.
    await act(async () => {
      sources[0]?.deferred?.release();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // The demo opens anonymously from the snapshot: no cached live copy, no signed-in banner.
    await press(host, "Open live demo");
    expect(host.textContent).toContain(snapshotBanner);
    expect(host.textContent).toContain("Snapshot message.");
    expect(host.textContent).not.toContain("Live copy message.");
    expect(host.querySelector(".signed-in")).toBeNull();
    expect(sources).toHaveLength(1);
  });

  it("drops an open that was running when the token was saved", async () => {
    // No snapshot, so the open asks the live source, which waits.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { status: 404 }))),
    );
    const deferred = deferredSource();
    const created: (Secret | null)[] = [];
    const host = await mountRoot({
      createLiveDemoSource: (token) => {
        created.push(token);
        return created.length === 1 ? deferred.source : new FixtureSource(FILES);
      },
    });
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Open live demo")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(created).toEqual([null]);
    // Meanwhile the user saves a token in Settings (a second screen of the same page).
    await openTokenSettings(host);
    await saveToken(host, SECRET_A);
    await act(async () => {
      deferred.release();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // The anonymous copy was not cached under the new token: the demo reads again with it.
    await press(host, "Settings", true);
    await press(host, "Open live demo");
    expect(created.map((token) => token?.reveal() ?? null)).toEqual([null, SECRET_A]);
    expect(host.textContent).toContain("Live copy message.");
  });

  it("does not let an earlier anonymous rate limit block the new token's check", async () => {
    stubSnapshot();
    const created: (Secret | null)[] = [];
    const host = await mountRoot({
      createLiveDemoSource: (token) => {
        created.push(token);
        if (created.length > 1) return new FixtureSource(FILES);
        // The anonymous check waits, then fails with a rate limit that lasts an hour.
        const limited = new FixtureSource(FILES);
        vi.spyOn(limited, "head").mockImplementation(async () => {
          await gate;
          throw new SourceError("rate-limited", "", 403, new Date(Date.now() + 3_600_000));
        });
        return limited;
      },
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await press(host, "Open live demo");
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "Check live now")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(created).toEqual([null]);

    // A token is saved while the anonymous check is still running, then the check fails.
    await press(host, "Settings", true);
    await fillRepository(host);
    await saveToken(host, SECRET_A);
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // The anonymous limit is not the token's: its check goes ahead at once.
    await press(host, "Settings", true);
    await press(host, "Open live demo");
    await press(host, "Check live now", true);
    expect(created.map((token) => token?.reveal() ?? null)).toEqual([null, SECRET_A]);
    expect(host.textContent).toContain("Live copy message.");
  });

  it("clears the cached live copy whenever the demo token changes, including to none", async () => {
    stubSnapshot();
    const created: (Secret | null)[] = [];
    const stores = { memory: new MemoryStore(), "browser-encrypted": new MemoryStore() };
    const host = await mountRoot({
      stores,
      createLiveDemoSource: (token) => {
        created.push(token);
        return new FixtureSource(FILES);
      },
    });
    const openDemoAndCheck = async () => {
      await press(host, "Settings", true);
      await press(host, "Open live demo");
      if (host.querySelector(".signed-in") === null) await press(host, "Check live now", true);
    };

    await openTokenSettings(host);
    await saveToken(host, SECRET_A);
    await openDemoAndCheck();
    expect(host.textContent).toContain("Live copy message.");
    expect(created.map((token) => token?.reveal() ?? null)).toEqual([SECRET_A]);

    // Back in the cached live copy: no new source is created while the token is unchanged.
    await press(host, "Settings", true);
    await press(host, "Open live demo");
    expect(created).toHaveLength(1);

    // A different token: the old live copy is gone and the next check reads with the new one.
    await press(host, "Settings", true);
    await saveToken(host, SECRET_B);
    await openDemoAndCheck();
    expect(created.map((token) => token?.reveal() ?? null)).toEqual([SECRET_A, SECRET_B]);

    // Saving the same token again keeps the copy.
    await press(host, "Settings", true);
    await saveToken(host, SECRET_B);
    await press(host, "Settings", true);
    await press(host, "Open live demo");
    expect(created).toHaveLength(2);

    // A token that goes to the encrypted store is not used by the demo: the copy goes too.
    await press(host, "Settings", true);
    await saveToken(host, SECRET_A, true);
    await press(host, "Settings", true);
    await press(host, "Open live demo");
    expect(host.textContent).toContain(snapshotBanner);
    expect(host.querySelector(".signed-in")).toBeNull();
    expect(created).toHaveLength(2);
  });

  it("sends the token to the API host only, never with the snapshot request or elsewhere", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
        // The snapshot is missing, so the demo asks the API, which is rate limited.
        return Promise.resolve(
          url.includes("demo-snapshot.json")
            ? new Response("", { status: 404 })
            : new Response("{}", {
                status: 403,
                headers: {
                  "x-ratelimit-limit": "5000",
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
                },
              }),
        );
      }),
    );
    const host = await mountRoot({
      createLiveDemoSource: (token) =>
        new GitHubSource({
          apiBase: "https://api.github.com",
          owner: "sympoies",
          repo: "agent-collab-demo",
          branch: null,
          token,
        }),
    });
    await press(host, "Open live demo");
    const anonymous = calls.splice(0);
    expect(anonymous.some((call) => call.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(anonymous.every((call) => call.authorization === null)).toBe(true);

    await press(host, "Settings", true);
    await fillRepository(host);
    await saveToken(host, SECRET_A);
    calls.length = 0;
    await press(host, "Settings", true);
    await press(host, "Open live demo");
    await press(host, "Check live now", true);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const target = new URL(call.url, "http://localhost/");
      if (target.hostname === "api.github.com") {
        expect(call.authorization, call.url).toBe(`Bearer ${SECRET_A}`);
      } else {
        // Same-origin snapshot request: no credentials of any kind.
        expect(target.hostname, call.url).toBe("localhost");
        expect(call.authorization, call.url).toBeNull();
      }
    }
    expect(calls.some((call) => call.url.includes("demo-snapshot.json"))).toBe(true);
    expect(calls.some((call) => call.url.startsWith("https://api.github.com/"))).toBe(true);
  });

  it("stores no token anywhere, and a remount is anonymous again", async () => {
    stubSnapshot();
    const { values, storage } = plainStorage();
    const stores = { memory: new MemoryStore(), "browser-encrypted": new MemoryStore() };
    const created: (Secret | null)[] = [];
    const create = (token: Secret | null) => {
      created.push(token);
      return new FixtureSource(FILES);
    };
    const localBefore = window.localStorage.length;
    const sessionBefore = window.sessionStorage.length;
    const host = await mountRoot({ storage, stores, createLiveDemoSource: create });
    await openTokenSettings(host);
    await saveToken(host, SECRET_A);
    expect(host.querySelector(".signed-in")).not.toBeNull();
    // Non-secret settings are saved; the secret is in no browser storage and not in the page.
    expect(values.size).toBeGreaterThan(0);
    for (const value of values.values()) expect(value).not.toContain(SECRET_A);
    expect(window.localStorage.length).toBe(localBefore);
    expect(window.sessionStorage.length).toBe(sessionBefore);
    expect(Object.keys(window.localStorage).join()).not.toContain(SECRET_A);
    expect(host.textContent).not.toContain(SECRET_A);
    expect((await stores["browser-encrypted"].get("access-token")) === null).toBe(true);
    await press(host, "Remove token");
    for (const value of values.values()) expect(value).not.toContain(SECRET_A);
    expect(await stores.memory.get("access-token")).toBeNull();
    expect(host.textContent).not.toContain(SECRET_A);

    // A fresh page (a new Root with fresh in-memory state) is anonymous.
    act(() => {
      mounted?.root.unmount();
    });
    document.body.replaceChildren();
    const again = await mountRoot({
      storage,
      stores: { memory: new MemoryStore(), "browser-encrypted": new MemoryStore() },
      createLiveDemoSource: create,
    });
    await press(again, "Open live demo");
    await press(again, "Check live now", true);
    expect(created.at(-1)).toBeNull();
    expect(again.querySelector(".signed-in")).toBeNull();
  });
});

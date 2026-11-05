// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatDateTime } from "../src/i18n/translate";
import { MemoryStore } from "../src/credentials/store";
import { Secret } from "../src/credentials/secret";
import { Loader } from "../src/loader/loader";
import { DEMO_REPOSITORY } from "../src/settings/live-demo";
import { PLAIN_TOKEN_URL, tokenCreationUrl } from "../src/settings/token-link";
import { FixtureSource } from "../src/source/fixture";
import { SourceError, type MessageSource, type RateLimit } from "../src/source/types";
import { DEFAULT_DRAFT } from "../src/settings/model";
import { App } from "../src/ui/App";
import { SettingsView } from "../src/ui/SettingsView";
import { Root } from "../src/ui/Root";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { messageText } from "./support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DOCUMENTED = new Set(["name", "description", "target_name", "expires_in", "contents"]);
const text = { name: "Collab Viewer (read-only)", description: "Read-only access." };

describe("the token link", () => {
  const url = (options: Partial<Parameters<typeof tokenCreationUrl>[0]>) =>
    tokenCreationUrl({
      endpoint: "https://api.github.com",
      repository: "",
      privateAccess: false,
      ...text,
      ...options,
    });

  it("uses only documented parameters and carries no secret", () => {
    const link = new URL(url({ repository: "alice-org/collab", privateAccess: true }) ?? "");
    expect(`${link.origin}${link.pathname}`).toBe(PLAIN_TOKEN_URL);
    expect([...link.searchParams.keys()].every((key) => DOCUMENTED.has(key))).toBe(true);
    expect(Object.fromEntries(link.searchParams)).toEqual({
      name: "Collab Viewer (read-only)",
      description: "Read-only access.",
      expires_in: "30",
      target_name: "alice-org",
      contents: "read",
    });
  });

  it("asks for no permission for a public repository and no owner when unknown", () => {
    const params = new URL(url({}) ?? "").searchParams;
    expect(params.has("contents")).toBe(false);
    expect(params.has("target_name")).toBe(false);
    expect(new URL(url({ repository: "not a repo" }) ?? "").searchParams.has("target_name")).toBe(
      false,
    );
  });

  it("names the owner only for a plain owner/name, and asks for contents only off the demo", () => {
    for (const odd of [
      "a/b/c",
      "al ice/x",
      "alice;drop/x",
      "alice/",
      "/x",
      "alice",
      "é/x",
      "a&b/x",
    ]) {
      expect(new URL(url({ repository: odd }) ?? "").searchParams.has("target_name"), odd).toBe(
        false,
      );
    }
    const withOwner = new URL(url({ repository: "Alice-Org/some_repo.v2" }) ?? "").searchParams;
    expect(withOwner.get("target_name")).toBe("Alice-Org");
    // The demo repository is public: Root passes privateAccess false for it.
    expect(new URL(url({ repository: DEMO_REPOSITORY }) ?? "").searchParams.has("contents")).toBe(
      false,
    );
    expect(
      new URL(url({ repository: "alice-org/collab", privateAccess: true }) ?? "").searchParams.get(
        "contents",
      ),
    ).toBe("read");
  });

  it("has no link for an endpoint that is not GitHub's public API", () => {
    expect(url({ endpoint: "https://git.example.com/api/v3" })).toBeNull();
  });
});

describe("the Settings link, through the screen", () => {
  let host: HTMLElement;
  let root: ReactRoot;
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.replaceChildren();
  });

  async function settingsFor(repository: string): Promise<URL> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <SettingsView
            initial={{ ...DEFAULT_DRAFT, repository }}
            storedEndpoints={{ memory: null, "browser-encrypted": null }}
            onSave={() => Promise.resolve(null)}
            onRemoveCredentials={() => Promise.resolve()}
            onCancel={null}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    const link = [...host.querySelectorAll<HTMLAnchorElement>("#token-section a")].find(
      (candidate) => candidate.textContent === "Create a token on GitHub",
    );
    expect(link).toBeDefined();
    return new URL(link?.href ?? "");
  }

  it("asks for read access to contents and names the typed owner for a repository that is not the demo", async () => {
    const params = (await settingsFor("alice-org/collab")).searchParams;
    expect(params.get("contents")).toBe("read");
    expect(params.get("target_name")).toBe("alice-org");
  });

  it("asks for no permission for the public demo repository", async () => {
    const params = (await settingsFor(DEMO_REPOSITORY)).searchParams;
    expect(params.has("contents")).toBe(false);
    expect(params.get("target_name")).toBe("sympoies");
  });

  it("asks for no permission and names no owner before a repository is typed", async () => {
    const params = (await settingsFor("")).searchParams;
    expect(params.has("contents")).toBe(false);
    expect(params.has("target_name")).toBe(false);
  });
});

describe("rate-limit steering in the viewer", () => {
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

  const A = "2026-10-01T0900-alice-agent-api-01";
  const files = {
    ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent\n",
    [`inbox/${A}.md`]: messageText(A, "alice-agent", "api"),
  };

  async function mount(node: React.ReactNode): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          {node}
        </ThemeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return host;
  }

  async function app(extra: Partial<Parameters<typeof App>[0]>, source?: MessageSource) {
    const loader = new Loader(source ?? new FixtureSource(files));
    await loader.open();
    return mount(
      <App
        loader={loader}
        title="Repo"
        selfNames={new Set()}
        identity={{ storage: null, key: "t" }}
        notice={null}
        onOpenSettings={() => undefined}
        {...extra}
      />,
    );
  }
  const button = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

  it("offers the token action when the limit is why a static copy stays, and only then", async () => {
    const onUseToken = vi.fn();
    const shown = await app({ onUseToken, limitHit: true, notice: "Paused." });
    expect(button(shown, "Use a token for a higher limit")).toBeDefined();
    await act(async () => {
      button(shown, "Use a token for a higher limit")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(onUseToken).toHaveBeenCalledOnce();

    act(() => {
      mounted?.root.unmount();
    });
    document.body.replaceChildren();
    const quiet = await app({ onUseToken, limitHit: false });
    expect(button(quiet, "Use a token for a higher limit")).toBeUndefined();
    act(() => {
      mounted?.root.unmount();
    });
    document.body.replaceChildren();
    const signedIn = await app({
      onUseToken,
      limitHit: true,
      signedIn: { onRemove: () => undefined },
    });
    expect(button(signedIn, "Use a token for a higher limit")).toBeUndefined();
  });

  it("offers it on a rate-limit error alert too", async () => {
    const limited: MessageSource = {
      head: () =>
        Promise.reject(new SourceError("rate-limited", "", 403, new Date(Date.now() + 3_600_000))),
      listDirectory: () => Promise.resolve([]),
      readFile: () => Promise.resolve(""),
      rateLimit: () => null,
    };
    const loader = new Loader(new FixtureSource(files));
    await loader.open();
    vi.spyOn(loader, "refresh").mockRejectedValue(
      new SourceError("rate-limited", "", 403, new Date(Date.now() + 3_600_000)),
    );
    expect(limited).toBeDefined();
    const host = await mount(
      <App
        loader={loader}
        title="Repo"
        selfNames={new Set()}
        identity={{ storage: null, key: "t" }}
        notice={null}
        onOpenSettings={() => undefined}
        onUseToken={() => undefined}
      />,
    );
    const refresh = host.querySelector<HTMLButtonElement>('[aria-label="Refresh"]');
    await act(async () => {
      refresh?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(button(host, "Use a token for a higher limit")).toBeDefined();
  });

  it("shows the signed-in banner with the budget the API reported, and a way to remove the token", async () => {
    const budget: RateLimit = {
      limit: 5000,
      remaining: 4800,
      resetAt: new Date("2026-11-04T10:00:00Z"),
    };
    const inner = new FixtureSource(files);
    const source: MessageSource = {
      head: (previous) => inner.head(previous),
      listDirectory: (revision, path) => inner.listDirectory(revision, path),
      readFile: (entry) => inner.readFile(entry),
      rateLimit: () => budget,
    };
    const onRemove = vi.fn();
    const host = await app({ signedIn: { onRemove } }, source);
    const banner = host.querySelector(".signed-in");
    expect(banner?.textContent).toContain("Signed in with a token: higher limit.");
    expect(banner?.textContent).toContain("4800 of 5000 requests left this hour.");
    await act(async () => {
      button(host, "Remove token")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it.each([
    ["none left", { limit: 5000, remaining: 0 }, "0 of 5000 requests left this hour."],
    ["more left than the limit", { limit: 5000, remaining: 9000 }, null],
    ["a huge number", { limit: 5000, remaining: 1e21 }, null],
    ["not a number", { limit: Number.NaN, remaining: 4 }, null],
    ["a fraction", { limit: 5000, remaining: 4.5 }, null],
    ["a negative number", { limit: 5000, remaining: -1 }, null],
    ["a zero limit", { limit: 0, remaining: 0 }, null],
  ])("shows a reported budget only when it is plausible: %s", async (_name, numbers, expected) => {
    const inner = new FixtureSource(files);
    const source: MessageSource = {
      head: (previous) => inner.head(previous),
      listDirectory: (revision, path) => inner.listDirectory(revision, path),
      readFile: (entry) => inner.readFile(entry),
      rateLimit: () => ({ ...numbers, resetAt: new Date("2026-11-04T10:00:00Z") }),
    };
    const host = await app({ signedIn: { onRemove: () => undefined } }, source);
    const banner = host.querySelector(".signed-in")?.textContent ?? "";
    expect(banner).toContain("Signed in with a token: higher limit.");
    if (expected === null) expect(banner).not.toContain("requests left");
    else expect(banner).toContain(expected);
  });

  async function refreshWith(error: SourceError, extra: Partial<Parameters<typeof App>[0]>) {
    const loader = new Loader(new FixtureSource(files));
    await loader.open();
    vi.spyOn(loader, "refresh").mockRejectedValue(error);
    const host = await mount(
      <App
        loader={loader}
        title="Repo"
        selfNames={new Set()}
        identity={{ storage: null, key: "t" }}
        notice={null}
        onOpenSettings={() => undefined}
        {...extra}
      />,
    );
    await act(async () => {
      host
        .querySelector('[aria-label="Refresh"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    return host;
  }
  const limit = () => new SourceError("rate-limited", "", 403, new Date(Date.now() + 3_600_000));

  it("does not offer a token for an error that a token would not fix", async () => {
    const host = await refreshWith(new SourceError("unauthorized", "", 401), {
      onUseToken: () => undefined,
    });
    expect(button(host, "Use a token for a higher limit")).toBeUndefined();
  });

  it("does not offer it in a viewer that is not the demo (no handler)", async () => {
    const host = await refreshWith(limit(), {});
    expect(button(host, "Use a token for a higher limit")).toBeUndefined();
  });

  it("does not offer it when already signed in, even with a rate-limit error alert", async () => {
    const host = await refreshWith(limit(), {
      onUseToken: () => undefined,
      signedIn: { onRemove: () => undefined },
    });
    expect(button(host, "Use a token for a higher limit")).toBeUndefined();
    expect(host.querySelector(".signed-in")).not.toBeNull();
  });

  it("omits the budget until a response carried one", async () => {
    const host = await app({ signedIn: { onRemove: () => undefined } });
    expect(host.querySelector(".signed-in")?.textContent).not.toContain("requests left");
  });
});

describe("the demo, the token and Settings through Root", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("walks from the rate-limit notice to the token field, saves a token, uses it for the live check and removes it", async () => {
    const id = "2026-11-03T0900-alice-agent-api-01";
    const snapshot = {
      schemaVersion: 1,
      generatedAt: "2026-11-03T08:00:00.000Z",
      revision: "snapshot-tree",
      files: [
        { path: ".agent-collab", text: "collab-protocol: 1\nparticipants: alice-agent\n" },
        { path: `inbox/${id}.md`, text: messageText(id, "alice-agent", "api") },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(snapshot), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    const limited: MessageSource = {
      head: () =>
        Promise.reject(new SourceError("rate-limited", "", 403, new Date(Date.now() + 3_600_000))),
      listDirectory: () => Promise.resolve([]),
      readFile: () => Promise.resolve(""),
      rateLimit: () => null,
    };
    const fine = new FixtureSource({
      ".agent-collab": "collab-protocol: 1\nparticipants: alice-agent\n",
      [`inbox/${id}.md`]: messageText(id, "alice-agent", "api"),
    });
    const tokensSeen: (Secret | null)[] = [];
    const createLiveDemoSource = vi.fn((token: Secret | null) => {
      tokensSeen.push(token);
      return tokensSeen.length === 1 ? limited : fine;
    });
    const memory = new MemoryStore();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThemeProvider storage={{ getItem: () => null, setItem: () => undefined }}>
          <Root
            storage={{ getItem: () => null, setItem: () => undefined }}
            stores={{ memory, "browser-encrypted": new MemoryStore() }}
            createSource={() => fine}
            createDemoSource={() => fine}
            createLiveDemoSource={createLiveDemoSource}
            openLocalFolder={null}
          />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    const press = async (label: string, attribute = false) => {
      const target = [...host.querySelectorAll("button")].find(
        (candidate) =>
          (attribute ? candidate.getAttribute("aria-label") : candidate.textContent) === label,
      );
      expect(target, label).toBeDefined();
      await act(async () => {
        target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    // The welcome screen shows the two paths and the limit.
    expect(host.textContent).toContain("Try the demo");
    expect(host.textContent).toContain("Connect a repository");
    expect(host.textContent).toContain("60 anonymous requests per hour");

    await press("Open live demo");
    await press("Check live now", true);
    expect(tokensSeen).toEqual([null]);
    expect(host.textContent).toContain("hit GitHub's API limit");
    await press("Use a token for a higher limit");

    // Settings opens at the token section with the demo repository and the field focused.
    expect(host.querySelector("#token-section")).not.toBeNull();
    const repository = host.querySelector<HTMLInputElement>(
      'input[placeholder="owner/repository"]',
    );
    expect(repository?.value).toBe(DEMO_REPOSITORY);
    expect(document.activeElement?.getAttribute("type")).toBe("password");
    const link = host.querySelector<HTMLAnchorElement>("#token-section a");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.href).not.toContain("token=");

    // Saving a token opens the repository signed in; the banner offers to remove it.
    const tokenField = host.querySelector<HTMLInputElement>('input[type="password"]');
    const secret = "test-token-not-real";
    await act(async () => {
      // React tracks the value property; the prototype setter makes the change visible to it.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        tokenField,
        secret,
      );
      tokenField?.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector(".signed-in")?.textContent).toContain("Signed in with a token");
    // The page text never contains the token.
    expect(host.textContent).not.toContain(secret);

    // Back in the demo (through Settings), the live check now carries the token.
    await press("Settings", true);
    await press("Open live demo");
    await press("Check live now", true);
    expect(tokensSeen).toHaveLength(2);
    expect(tokensSeen[1]?.reveal()).toBe(secret);

    // Removing the token forgets it everywhere and returns to anonymous behavior.
    await press("Remove token");
    expect(host.textContent).toContain("Try the demo");
    expect(await memory.get("access-token")).toBeNull();
    // The live copy read with the token is gone too: the demo opens from the snapshot again.
    await press("Open live demo");
    expect(host.textContent).toContain(
      `Showing the snapshot generated at ${formatDateTime("en", new Date(snapshot.generatedAt))}.`,
    );
    expect(host.querySelector(".signed-in")).toBeNull();
    expect(createLiveDemoSource).toHaveBeenCalledTimes(2);

    act(() => {
      root.unmount();
    });
  });
});

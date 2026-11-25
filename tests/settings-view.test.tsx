// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { en } from "../src/i18n/catalog";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DRAFT, STORAGE_WARNINGS, type CredentialStorage } from "../src/settings/model";
import { SettingsView } from "../src/ui/SettingsView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function render(
  tokenStored: boolean,
  inStore: CredentialStorage = "memory",
  endpoint = DEFAULT_DRAFT.endpoint,
  selectedStorage: CredentialStorage = "memory",
  showAdvanced = true,
): string {
  const stored = tokenStored ? "https://api.github.com" : null;
  return renderToStaticMarkup(
    <SettingsView
      initial={{
        ...DEFAULT_DRAFT,
        repository: "alice-org/collab",
        endpoint,
        credentialStorage: selectedStorage,
      }}
      storedEndpoints={{ memory: null, "browser-encrypted": null, [inStore]: stored }}
      onSave={() => Promise.resolve(null)}
      onRemoveCredentials={() => Promise.resolve()}
      onCancel={null}
      showAdvanced={showAdvanced}
    />,
  );
}

describe("SettingsView", () => {
  let mounted: { host: HTMLElement; root: Root } | null = null;

  afterEach(() => {
    if (mounted !== null) act(() => mounted?.root.unmount());
    mounted = null;
    document.body.replaceChildren();
  });

  it("shows participant ID settings only in Advanced", () => {
    expect(render(false, "memory", DEFAULT_DRAFT.endpoint, "memory", false)).not.toContain(
      en["settings.myNames"],
    );
    expect(render(false, "memory", DEFAULT_DRAFT.endpoint, "memory", true)).toContain(
      en["settings.myNames"],
    );
    expect(render(false, "memory", DEFAULT_DRAFT.endpoint, "memory", true)).toContain(
      en["settings.advanced"],
    );
  });

  it("opens Advanced and shows the participant ID error after a failed save", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    act(() => {
      root.render(
        <SettingsView
          initial={{ ...DEFAULT_DRAFT, repository: "alice-org/collab" }}
          storedEndpoints={{ memory: null, "browser-encrypted": null }}
          onSave={() => Promise.resolve({ selfNames: "settings.error.names" })}
          onRemoveCredentials={() => Promise.resolve()}
          onCancel={null}
          showAdvanced
        />,
      );
    });

    await act(async () => {
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(host.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en["settings.error.names"]);
  });

  it("masks the token input and leaves it empty", () => {
    const secretInputs = render(true).match(/<input[^>]*type="password"[^>]*>/g) ?? [];
    expect(secretInputs).toHaveLength(1);
    for (const input of secretInputs) {
      expect(input).toContain('value=""');
      expect(input).toContain('autoComplete="off"');
    }
  });

  it("offers to keep or remove a stored token", () => {
    const html = render(true);
    expect(html).toContain('placeholder="stored; leave empty to keep it"');
    expect(html).toContain("Remove stored credentials");
    expect(render(false)).not.toContain("Remove stored credentials");
  });

  it("describes the token of the selected store, not of another one", () => {
    const html = render(true, "browser-encrypted");
    expect(html).not.toContain("stored; leave empty to keep it");
    expect(html).toContain("Remove stored credentials");
  });

  it("describes the token for the endpoint being edited", () => {
    expect(render(true, "memory", "https://api.github.com/")).toContain(
      'placeholder="stored; leave empty to keep it"',
    );
    const other = render(true, "memory", "https://github.example.com/api/v3");
    expect(other).not.toContain("stored; leave empty to keep it");
    expect(other).toContain("Remove stored credentials");
  });

  it("does not ask for a private key before decryption exists", () => {
    const html = render(false);
    expect(html).not.toContain("Private key (optional)");
    expect(html).toContain("Private keys are not accepted until decryption is available.");
  });

  it("shows the warning for the selected credential storage", () => {
    expect(render(false)).toContain(en[STORAGE_WARNINGS.memory]);
  });

  it("warns that sibling GitHub Pages projects share browser storage", () => {
    vi.stubGlobal("window", { location: { hostname: "alice-agent.github.io" } });
    try {
      const html = render(false, "memory", DEFAULT_DRAFT.endpoint, "browser-encrypted");
      expect(html).toContain("Sibling GitHub Pages projects");
      expect(html).toContain("Prefer In memory only");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

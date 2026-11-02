import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DRAFT, STORAGE_WARNINGS, type CredentialStorage } from "../src/settings/model";
import { SettingsView } from "../src/ui/SettingsView";

function render(
  tokenStored: boolean,
  inStore: CredentialStorage = "memory",
  endpoint = DEFAULT_DRAFT.endpoint,
  selectedStorage: CredentialStorage = "memory",
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
      onOpenDemo={() => undefined}
    />,
  );
}

describe("SettingsView", () => {
  it("masks the token input and leaves it empty", () => {
    const secretInputs = render(true).match(/<input type="password"[^>]*>/g) ?? [];
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
    expect(render(false)).toContain(STORAGE_WARNINGS.memory);
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

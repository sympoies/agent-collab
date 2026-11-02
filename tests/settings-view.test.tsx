import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DEFAULT_DRAFT, STORAGE_WARNINGS } from "../src/settings/model";
import { SettingsView } from "../src/ui/SettingsView";

function render(tokenStored: boolean): string {
  return renderToStaticMarkup(
    <SettingsView
      initial={{ ...DEFAULT_DRAFT, repository: "alice-org/collab" }}
      tokenStored={tokenStored}
      onSave={() => Promise.resolve(null)}
      onRemoveCredentials={() => Promise.resolve()}
      onCancel={null}
      onOpenDemo={() => undefined}
    />,
  );
}

describe("SettingsView", () => {
  it("masks both secret inputs and leaves them empty", () => {
    const secretInputs = render(true).match(/<input type="password"[^>]*>/g) ?? [];
    expect(secretInputs).toHaveLength(2);
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

  it("shows the warning for the selected credential storage", () => {
    expect(render(false)).toContain(STORAGE_WARNINGS.memory);
  });
});

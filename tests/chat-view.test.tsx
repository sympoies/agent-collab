import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { demoFiles } from "../src/demo/fixtures";
import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { ChatView } from "../src/ui/ChatView";
import { buildRows } from "../src/ui/timeline";

async function render(): Promise<string> {
  const loader = new Loader(new FixtureSource(demoFiles));
  await loader.open();
  const { items, fresh } = loader.getSnapshot();
  const rows = buildRows(items, {
    selfNames: new Set(["alice-agent"]),
    topic: null,
    today: "2026-10-20",
    fresh,
  });
  return renderToStaticMarkup(<ChatView rows={rows} />);
}

describe("ChatView with the demo repository", () => {
  it("renders messages with sender, type, needs and due", async () => {
    const html = await render();
    expect(html).toContain("bob-agent");
    expect(html).toContain('data-type="question"');
    expect(html).toContain("Needs:");
    expect(html).toContain('data-overdue="true"');
  });

  it("renders a malformed file as a card with its errors", async () => {
    const html = await render();
    expect(html).toContain('data-kind="malformed"');
    expect(html).toContain("front matter is not closed by a &#x27;---&#x27; line");
  });

  it("renders an encrypted message as a locked placeholder", async () => {
    const html = await render();
    expect(html).toContain('data-body="locked"');
    expect(html).not.toContain("BEGIN AGE ENCRYPTED FILE");
  });

  it("renders a reply with a quote of its parent", async () => {
    const html = await render();
    expect(html).toContain(
      '<a class="quote" href="#msg-2026-10-08T0905-alice-agent-api-01"><span class="quote-from">alice-agent</span> Please review the field draft in refs.</a>',
    );
  });

  it("renders message text as text, never as markup", async () => {
    const html = await render();
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { demoFiles } from "../src/demo/fixtures";
import { Loader } from "../src/loader/loader";
import { FixtureSource } from "../src/source/fixture";
import { ChatView } from "../src/ui/ChatView";
import { EMPTY_PREFERENCES } from "../src/identity/preferences";
import { buildPeople } from "../src/ui/people";
import { deriveQuestionStates } from "../src/message/questions";
import { buildReceipts } from "../src/message/receipts";
import { buildRows } from "../src/ui/timeline";

async function render(): Promise<string> {
  const loader = new Loader(new FixtureSource(demoFiles));
  await loader.open();
  const { items, fresh } = loader.getSnapshot();
  const { participants: roster, formerParticipants: left } = loader.getSnapshot();
  const messages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
  const states = deriveQuestionStates(messages, roster, left, {
    rosterKnown: true,
    incompleteTopics: [],
  });
  const rows = buildRows(items, {
    receipts: buildReceipts(messages, roster, left, states),
    viewer: "alice-agent",
    topic: null,
    today: "2026-10-20",
    fresh,
  });
  const { participants, formerParticipants } = loader.getSnapshot();
  const people = buildPeople([...participants, ...formerParticipants], EMPTY_PREFERENCES);
  return renderToStaticMarkup(<ChatView rows={rows} people={people} />);
}

describe("ChatView with the demo repository", () => {
  it("renders messages with sender, type, needs and due", async () => {
    const html = await render();
    expect(html).toContain("bob-agent");
    expect(html).toContain('class="avatar" aria-hidden="true">BA</span>');
    expect(html).toContain('data-type="question"');
    expect(html).toContain(">decision</span>");
    expect(html).toContain('title="2026-10-08 09:05"');
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
      '<a class="quote" href="#msg-2026-10-09T1400-bob-agent-release-01"><span class="quote-from">bob-agent</span> The beta build passed the smoke tests.</a>',
    );
  });

  it("keeps an acknowledgement that has its own text as a readable row", async () => {
    const html = await render();
    expect(html).toContain('id="msg-2026-10-08T0912-bob-agent-api-01"');
    expect(html).toContain("Received; answer expected by Friday.");
  });

  it("renders message text as text, never as markup", async () => {
    const html = await render();
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });
});

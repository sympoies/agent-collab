import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EMPTY_PREFERENCES } from "../src/identity/preferences";
import { Loader } from "../src/loader/loader";
import { deriveQuestionStates } from "../src/message/questions";
import { buildReceipts } from "../src/message/receipts";
import { FixtureSource } from "../src/source/fixture";
import { ChatView } from "../src/ui/ChatView";
import { plainInline } from "../src/ui/Markdown";
import { buildPeople } from "../src/ui/people";
import { buildRows } from "../src/ui/timeline";
import { flat, MARKER, messageText } from "./support";

const PARENT = "2026-10-01T0901-alice-agent-api-01";
const REPLY = "2026-10-01T0902-bob-agent-api-01";

/** The quote line of a reply to a message whose first line is `first`. */
async function quoteOf(first: string): Promise<string> {
  const files = {
    ".agent-collab": `${MARKER}participants: alice-agent, bob-agent\n`,
    [flat("2026-10", 1, 1)]: messageText(
      PARENT,
      "alice-agent",
      "api",
      { type: "info", needs: "none" },
      first,
    ),
    [flat("2026-10", 1, 2)]: messageText(
      REPLY,
      "bob-agent",
      "api",
      { type: "info", needs: "none", reply_to: PARENT },
      "Looking.",
    ),
  };
  const loader = new Loader(new FixtureSource(files));
  await loader.open();
  const { items, fresh, participants, formerParticipants } = loader.getSnapshot();
  const messages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
  const states = deriveQuestionStates(messages, participants, formerParticipants, {
    rosterKnown: true,
    incompleteTopics: {},
  });
  const rows = buildRows(items, {
    receipts: buildReceipts(messages, participants, formerParticipants, states),
    viewer: "alice-agent",
    topic: null,
    today: "2026-10-20",
    fresh,
  });
  const people = buildPeople([...participants, ...formerParticipants], EMPTY_PREFERENCES);
  const html = renderToStaticMarkup(
    <ChatView
      showTopic
      rows={rows}
      people={people}
      attachments={{ reader: loader.attachments, loadedIds: new Set(), onJump: () => undefined }}
      earlier={{ beforeId: null, disabled: false, onLoad: () => undefined }}
    />,
  );
  const quote = /<a class="quote" [^>]*>(.*?)<\/a>/.exec(html)?.[1] ?? "";
  return /<span class="quote-text">(.*?)<\/span>/.exec(quote)?.[1] ?? "";
}

describe("plainInline", () => {
  it("shows a link by its text and drops the target", () => {
    expect(plainInline("已開 [IA-3261](https://tracker.example/browse/IA-3261)，請協助研究")).toBe(
      "已開 IA-3261，請協助研究",
    );
  });

  it("shows the target when a link has no text, and the alt text of an image", () => {
    expect(plainInline("[](https://x.example/a) and ![diagram](https://x.example/i.png)")).toBe(
      "https://x.example/a and diagram",
    );
  });

  it("drops emphasis and code markers", () => {
    expect(plainInline("**bold** and *italic* and `code`")).toBe("bold and italic and code");
  });

  it("shows only the text of a link with an unsafe scheme", () => {
    expect(plainInline("[click](javascript:alert(1)) now")).toBe("click now");
  });

  it("leaves unbalanced markers and long lines alone", () => {
    expect(plainInline("a [half link](https://x.example and a * star")).toBe(
      "a [half link](https://x.example and a * star",
    );
    expect(plainInline("*draft")).toBe("*draft");
    expect(plainInline("`cmd")).toBe("`cmd");
    const long = `[a](https://x.example/${"b".repeat(2100)})`;
    expect(plainInline(long)).toBe(long);
  });
});

describe("the quote of a reply", () => {
  it("shows the original's Markdown as plain text", async () => {
    const quote = await quoteOf(
      "已開 [IA-3261](https://tracker.example/browse/IA-3261)，請協助研究 **now**",
    );
    expect(quote).toBe("已開 IA-3261，請協助研究 now");
  });

  it("omits block markers from a heading, quote, list item, and fenced code first line", async () => {
    expect(await quoteOf("# Heading *label*")).toBe("Heading label");
    expect(await quoteOf("> See [the doc](https://tracker.example/doc)")).toBe("See the doc");
    expect(await quoteOf("- Run `pnpm test`")).toBe("Run pnpm test");
    expect(await quoteOf("```ts\nconst answer = 42;\n```\nLater line")).toBe("const answer = 42;");
  });

  it("holds no link of its own: the whole quote is already a link", async () => {
    const quote = await quoteOf("See [the doc](https://tracker.example/doc).");
    expect(quote).not.toContain("<a ");
    expect(quote).not.toContain("](");
    expect(quote).not.toContain("[");
  });

  it("escapes what the original contained instead of passing it on as markup", async () => {
    const quote = await quoteOf("[<b>x</b>](https://tracker.example/doc) <i>y</i>");
    expect(quote).not.toContain("<b>");
    expect(quote).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

// The quote of a reply shows the original as plain text, never raw Markdown (issue #106). Synthetic
// data only. The "@csp" tag also runs these in WebKit.

import { expect, test, type Page } from "@playwright/test";

import { flat, MARKER, messageText } from "../tests/support";

const PARENT = "2026-10-01T0901-alice-agent-api-01";
const REPLY = "2026-10-01T0902-bob-agent-api-01";
const HEADING = "2026-10-02T0901-alice-agent-api-01";
const HEADING_REPLY = "2026-10-02T0902-bob-agent-api-01";
const BLOCKQUOTE = "2026-10-02T0903-alice-agent-api-01";
const BLOCKQUOTE_REPLY = "2026-10-02T0904-bob-agent-api-01";
const BULLET = "2026-10-02T0905-alice-agent-api-01";
const BULLET_REPLY = "2026-10-02T0906-bob-agent-api-01";
const CODE = "2026-10-02T0907-alice-agent-api-01";
const CODE_REPLY = "2026-10-02T0908-bob-agent-api-01";
const QUESTION = "2026-10-03T0901-alice-agent-ops-01";
const LONG = `${"Please look at the report and the notes again. ".repeat(6)}[the tracker item](https://tracker.example/browse/IA-1) and **more** text after it.`;
const BLOCK_QUOTES = [
  [HEADING, HEADING_REPLY, "# Heading *label*"],
  [BLOCKQUOTE, BLOCKQUOTE_REPLY, "> See [the doc](https://tracker.example/doc)"],
  [BULLET, BULLET_REPLY, "- Run `pnpm test`"],
  [CODE, CODE_REPLY, "```ts\nconst answer = 42;\n```\nLater line"],
] as const;

const snapshot = JSON.stringify({
  schemaVersion: 1,
  generatedAt: "2026-11-04T09:00:00.000Z",
  revision: "r1",
  files: [
    { path: ".agent-collab", text: `${MARKER}participants: alice-agent, bob-agent\n` },
    {
      path: flat("2026-10", 1, 1),
      text: messageText(
        PARENT,
        "alice-agent",
        "api",
        { type: "info", needs: "none" },
        "已開 [IA-3261](https://tracker.example/browse/IA-3261)，請協助研究 **now** `code`",
      ),
    },
    {
      path: flat("2026-10", 1, 2),
      text: messageText(
        REPLY,
        "bob-agent",
        "api",
        { type: "info", needs: "none", reply_to: PARENT },
        "Looking.",
      ),
    },
    {
      path: flat("2026-10", 1, 3),
      text: messageText(
        "2026-10-01T0903-alice-agent-api-01",
        "alice-agent",
        "api",
        { type: "info", needs: "none" },
        LONG,
      ),
    },
    {
      path: flat("2026-10", 1, 4),
      text: messageText(
        "2026-10-01T0904-bob-agent-api-01",
        "bob-agent",
        "api",
        { type: "info", needs: "none", reply_to: "2026-10-01T0903-alice-agent-api-01" },
        "Reading.",
      ),
    },
    ...BLOCK_QUOTES.flatMap(([parent, reply, firstLine]) => [
      {
        path: `inbox/2026-10/${parent}.md`,
        text: messageText(parent, "alice-agent", "api", { type: "info" }, firstLine),
      },
      {
        path: `inbox/2026-10/${reply}.md`,
        text: messageText(reply, "bob-agent", "api", { type: "info", reply_to: parent }, "Reply."),
      },
    ]),
    {
      path: flat("2026-10", 3, 1),
      text: messageText(
        QUESTION,
        "alice-agent",
        "ops",
        { type: "question", to: "bob-agent" },
        "[IA-1](https://tracker.example/browse/IA-1) needs review",
      ),
    },
  ],
});

async function open(page: Page, width: number) {
  await page.route("**/hosted-snapshot.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: snapshot }),
  );
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/");
  if (width === 390) await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByText("Looking.")).toBeVisible();
}

for (const width of [390, 1280]) {
  test(`the quote shows plain text at ${String(width)} px @csp`, async ({ page }) => {
    await open(page, width);
    const quote = page.locator(`a.quote[href="#msg-${PARENT}"] .quote-text`);
    await expect(quote).toHaveText("已開 IA-3261，請協助研究 now code");
    expect(await quote.evaluate((node) => node.innerHTML)).not.toMatch(/[[\]<]/);
    // The quote is itself a link, so it holds no link of its own.
    await expect(page.locator("a.quote a")).toHaveCount(0);
  });

  test(`a long quote is cut by the clamp, with no raw marker, at ${String(width)} px @csp`, async ({
    page,
  }) => {
    await open(page, width);
    const quote = page.locator(
      'a.quote[href="#msg-2026-10-01T0903-alice-agent-api-01"] .quote-text',
    );
    const text = await quote.evaluate((node) => node.textContent);
    expect(text).not.toContain("](");
    expect(text).not.toContain("**");
    expect(text).toContain("the tracker item");
    expect(await quote.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  });
}

test("first-line block markers and Questions links render as plain text @csp", async ({ page }) => {
  await open(page, 1280);
  const quotes = [
    [HEADING, "Heading label"],
    [BLOCKQUOTE, "See the doc"],
    [BULLET, "Run pnpm test"],
    [CODE, "const answer = 42;"],
  ] as const;
  for (const [parent, text] of quotes) {
    await expect(page.locator(`a.quote[href="#msg-${parent}"] .quote-text`)).toHaveText(text);
  }

  await page.getByRole("button", { name: /^Questions/ }).click();
  await expect(page.locator(`#question-${QUESTION} .question-text`)).toHaveText(
    "IA-1 needs review",
  );
});

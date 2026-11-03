# Viewer design

Status: accepted for the first slice (issue #1). Sections marked _later_ describe
reserved interfaces that later slices implement.

## 1. Goal and boundaries

The viewer shows the messages of one agent collaboration repository as a chat
room and highlights new messages while it runs. It is web first and is later
packaged with Tauri for macOS and Android.

- **Read-only.** The viewer never writes to a collaboration repository: no
  commits, no issues, no comments, no reactions. The provider interface has no
  write method, and the access credential only needs read permission.
- **Provider-neutral.** UI and message parsing only see the message-source
  interface (section 3). GitHub is implemented first; GitLab is a drop-in
  implementation of the same interface.
- **No server.** The client talks to the provider API directly. There is no
  push channel; updates come from polling (section 7).

**Threat model.** Collaboration repositories are private and their maintainers
are trusted. The design protects against accidents and credential leaks (a
token in a log, a URL, a screenshot, a crash report, a synced browser profile,
a fixture committed by mistake), not against a hostile public red team or a
compromised device.

## 2. Architecture

```text
┌─────────────────────────── UI (chat view, settings) ──────────────────────────┐
│ renders Message / MalformedFile, never sees provider types or credentials     │
└───────────────▲───────────────────────────────────────────────▲───────────────┘
                │ timeline state                                 │ settings model
┌───────────────┴──────────────┐                ┌───────────────┴───────────────┐
│ Loader + poller              │                │ Settings + credential store   │
│ layout discovery, paging,    │                │ keychain / Keystore / browser │
│ change detection, dedupe     │                └───────────────┬───────────────┘
└───────▲──────────────▲───────┘                                │ token (in memory)
        │ text         │ entries, revisions                     │
┌───────┴──────┐ ┌─────┴──────────────────────────────────────────▼──────────────┐
│ Parser       │ │ MessageSource interface                                       │
│ pure, no I/O │ │ GitHubSource │ GitLabSource (later) │ FixtureSource (tests)  │
└──────────────┘ └───────────────────────────────────────────────────────────────┘
```

Dependency rule: `ui → loader → {parser, source interface}`. Only the composition
root (app start-up) imports a concrete provider. The parser is a pure function
from `(path, text)` to a parsed file.

## 3. Message-source interface

The interface is the only place that knows about a hosting platform. It
exposes the smallest set of read operations the loader needs.

```ts
/** Opaque identity of the watched branch at one point in time (a commit id). */
interface Head {
  readonly revision: string;
  /** Change validator for the next conditional request (an ETag), if supported. */
  readonly validator: string | null;
}

interface DirectoryEntry {
  readonly name: string; // last path segment
  readonly path: string; // repository-relative, "/"-separated
  readonly kind: "file" | "directory";
  /** Content-addressed object id (a Git blob or tree id). Immutable. */
  readonly objectId: string;
}

interface RateLimit {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
}

interface MessageSource {
  /** Current head of the watched branch; "not-modified" when `previous` still matches. */
  head(previous: Head | null): Promise<Head | "not-modified">;
  /** Complete listing of one directory at a revision; the source pages internally. */
  listDirectory(revision: string, path: string): Promise<readonly DirectoryEntry[]>;
  /** UTF-8 text of a file entry obtained from listDirectory. */
  readFile(entry: DirectoryEntry): Promise<string>;
  /** Rate-limit state from the most recent response, or null if unknown. */
  rateLimit(): RateLimit | null;
}
```

Failures are a single error type with a closed set of kinds, so the UI can
react without parsing provider messages:

| Kind | Meaning | UI reaction |
| --- | --- | --- |
| `unauthorized` | credential missing, expired or revoked (401) | open settings |
| `forbidden` | credential lacks access to the repository (403 without rate-limit signal) | open settings when the first request fails; after a successful request, retry with backoff |
| `not-found` | repository, branch or path does not exist (404) | settings / empty state |
| `rate-limited` | primary or secondary limit hit; carries `retryAt` | pause polling until `retryAt` |
| `unreachable` | network error, DNS, TLS, VPN down, CORS rejection | offline banner, retry with backoff |
| `too-large` | listing does not fit the provider limits | error card, no partial data |
| `unexpected` | anything else (5xx, malformed JSON) | error banner, retry with backoff |

Errors never carry request headers, the credential, or the full request URL
with query string; they carry the kind, the HTTP status and the
repository-relative path.

### Why this shape

- **Only `head` is mutable.** Everything below a revision is addressed by
  content (tree and blob ids), so listings and file contents are cached in
  memory by object id for the session and never re-requested. A poll that finds
  no change costs one conditional request. A `304 Not Modified` response avoids
  transferring data, but GitHub exempts it from the primary rate limit only
  when the request is correctly authorized with an `Authorization` header;
  anonymous requests still count against the per-IP limit.
- **Paging stays inside the source.** Directory order differs between
  providers (and messages sort by id, not by API order), so the loader needs
  the complete listing of one directory anyway. History paging happens one
  level up, by month (section 4).
- **No write method.** Read-only is enforced by the type, not by convention.

### GitHub implementation

All calls go to the configured API base (default `https://api.github.com`):

| Operation | Endpoint | Notes |
| --- | --- | --- |
| default branch (once) | `GET /repos/{owner}/{repo}` | `default_branch`, when settings leave the branch empty |
| `head` | `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` | `If-None-Match: <etag>`; `304` → `"not-modified"` |
| commit → root tree | `GET /repos/{owner}/{repo}/git/commits/{sha}` | immutable, cached |
| `listDirectory` | `GET /repos/{owner}/{repo}/git/trees/{sha}` | walk from the root tree one segment at a time; every tree is immutable and cached |
| `readFile` | `GET /repos/{owner}/{repo}/git/blobs/{sha}` with `Accept: application/vnd.github.raw+json` | raw bytes, immutable, cached |

- Headers: optional `Authorization: Bearer <token>`, `X-GitHub-Api-Version`
  pinned, `Accept` as above. Anonymous requests omit `Authorization` entirely.
  Requests use `cache: "no-store"` so the browser HTTP
  cache never stores private content; the source sets `If-None-Match` itself.
  The API base must be an `https:` URL; the source refuses anything else.
- Requests use `redirect: "error"`, so the token is never sent on to another
  location. A renamed or transferred repository answers with a redirect and
  therefore shows as `unreachable`; the user updates the repository in
  settings.
- The Git database endpoints were chosen over the Contents API because the
  Contents API truncates directories at 1,000 entries, which a flat inbox can
  exceed, and its file responses embed `download_url` values with temporary
  tokens. The trees endpoint returns a directory in one response and is not
  paginated; when it reports `truncated: true` the source raises `too-large`
  instead of showing a partial history.
- Rate limit: read `x-ratelimit-limit`, `x-ratelimit-remaining` and
  `x-ratelimit-reset` from every response. A `403` or `429` with
  `x-ratelimit-remaining: 0` or a `retry-after` header becomes `rate-limited`
  with `retryAt` from `retry-after` (seconds) or `x-ratelimit-reset` (epoch
  seconds). Any other `403` is `forbidden`.
- CORS: the GitHub REST API allows cross-origin requests with an
  `Authorization` header and exposes `ETag` and the rate-limit headers, so the
  web build works without a proxy.

References: GitHub REST API docs on
[conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate),
[rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[Git trees](https://docs.github.com/en/rest/git/trees) and
[Git blobs](https://docs.github.com/en/rest/git/blobs) (checked 2026-11).

### What a GitLab implementation must absorb (_later_)

GitLab must fit behind the same interface with no change to the loader, the
parser or the UI. The differences it absorbs:

| Concern | GitHub | GitLab |
| --- | --- | --- |
| API base | `https://api.github.com` or `https://<host>/api/v3` (GitHub Enterprise Server) | `https://<host>/api/v4`; self-hosted is the common case (for example `https://gitlab.example.com/api/v4`) |
| Repository address | `/repos/{owner}/{repo}` | `/projects/{id}` where `id` is the URL-encoded full path (`group%2Fsubgroup%2Frepo`); nested groups allowed |
| Auth header | `Authorization: Bearer <token>` | `PRIVATE-TOKEN: <token>` (project or personal access token with `read_repository` / `read_api`) |
| Head | `git/ref/heads/{branch}` | `GET /projects/{id}/repository/branches/{branch}` → `commit.id` |
| Directory listing | tree by object id, unpaginated | `GET /projects/{id}/repository/tree?path=…&ref=<commit>`, paginated (keyset or `Link` header); the source follows pages until done |
| File read | blob by id, raw `Accept` | `GET /projects/{id}/repository/blobs/{sha}/raw` |
| Conditional requests | `ETag` / `304` on these endpoints | support varies by endpoint and version; when absent, `head` compares the commit id and every poll costs one request |
| Rate-limit headers | `x-ratelimit-*`, `retry-after` | `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`; instance-configured and may be absent |
| CORS | allowed | instance-dependent; a self-hosted instance may reject browser origins. The web build then needs the Tauri build or an instance setting; the source maps a CORS rejection to `unreachable` |
| Reachability | public internet | often only reachable over a VPN; a failed request while the VPN is down is `unreachable` (offline banner and backoff), never `unauthorized` |
| TLS | public CA | possibly a private CA; the Tauri build uses the OS trust store, the browser uses its own |

The GitLab facts above are to be verified with a probe against a real instance
when that slice starts; they do not change the interface.

## 4. Message model and parser

### Repository layout

- The top-level marker file `.agent-collab` identifies a collaboration
  repository. Its first line is `collab-protocol: 1`; an optional
  `inbox-layout: monthly` line selects monthly folders. A missing marker or an
  unknown protocol version is a setup error ("not a collaboration repository"
  / "unsupported protocol version").
- Messages live in `inbox/<id>.md` (flat) or `inbox/YYYY-MM/<id>.md` (monthly).
  Both locations can coexist in one repository (older flat messages stay valid
  after switching to monthly), so the loader always reads both. Long content
  lives under `topics/` and is referenced from `refs`.

### Message file

A message file starts with front matter between two `---` lines, one
`key: value` per line, then a body of one to five non-blank lines:

```markdown
---
id: 2026-10-08T0905-alice-agent-api-01
from: alice-agent
to: bob-agent
topic: api
type: question
reply_to:
refs: topics/api/fields-v1.md
needs: confirm the field list
due: 2026-10-10
---
Please review the field draft in refs and say which fields can become optional.
```

| Field | Required | Rule |
| --- | --- | --- |
| `id` | yes | `YYYY-MM-DDTHHMM-<from>-<topic>-<NN>`, equal to the file name stem; `NN` starts at `01` |
| `from` | yes | lowercase `[a-z0-9-]` |
| `to` | yes | comma-separated names, at least one |
| `topic` | yes | lowercase `[a-z0-9-]` |
| `type` | yes | `question`, `answer`, `info`, `decision-needed` or `ack` |
| `reply_to` | may be empty | a message id; required for `answer` and `ack` |
| `refs` | may be empty | comma-separated `topics/` paths, message ids or URLs |
| `needs` | yes | what the recipient should do; `none` (any case) when nothing is requested. The protocol also accepts the CJK equivalent (U+7121) |
| `due` | may be empty | `YYYY-MM-DD` |

The id timestamp is wall-clock time in the repository's configured time zone,
which the viewer does not know. The viewer displays it as written and sorts by
id, which is chronological by construction.

### Parsed model

```ts
type MessageType = "question" | "answer" | "info" | "decision-needed" | "ack";

type Body =
  | { state: "plain"; lines: readonly string[] }
  | { state: "locked"; armored: string }      // encrypted, no key or not yet decrypted
  | { state: "decrypted"; lines: readonly string[] }        // later
  | { state: "undecryptable"; reason: string };             // later

interface Message {
  id: string;
  path: string;
  timestamp: string;          // "YYYY-MM-DD HH:MM" from the id
  from: string;
  to: readonly string[];
  topic: string;
  type: MessageType | null;   // null when the value is not a known type
  replyTo: string | null;
  refs: readonly string[];
  needs: string | null;       // null when "none"
  due: string | null;
  body: Body;
  issues: readonly string[];  // non-fatal validation findings
}

type ParsedFile =
  | { kind: "message"; message: Message }
  | { kind: "malformed"; path: string; errors: readonly string[]; raw: string };
```

### Validation and tolerance

The parser never throws on file content. It sorts findings into two classes:

- **Fatal** (the file becomes `malformed`): no opening or closing `---`, a
  front matter line without `:`, a duplicate key, a missing `id`, `from`,
  `topic` or `to`, or an `id` that does not match the id pattern. Without
  these the message cannot be placed in the timeline or attributed.
- **Non-fatal** (the message renders with a warning marker listing `issues`):
  unknown keys, missing optional keys, an unknown `type`, `answer`/`ack`
  without `reply_to`, an invalid `reply_to`, `due` or name, an id that
  disagrees with `from`/`topic`, the file name or the month folder, an empty
  body, or more than five body lines.

Line endings may be `\n` or `\r\n`, and a leading UTF-8 byte order mark is
ignored, both in message files and in the marker file.

A malformed card shows the path and the errors; the raw text is available
behind an expander and is rendered as text, never as HTML. Files in `inbox/`
that are not `.md` (for example `.gitkeep`) are ignored. A file that fails to
download produces an error card for that path; the rest of the timeline
still renders. Refreshes download the file again with growing spacing (after
1, 2, 4, ... refreshes, at most every 15) until it succeeds. A file that is
still unavailable is not counted as new and not marked fresh.

### Loading and paging

1. Read the marker, then list `inbox/`. Collect flat `*.md` entries and
   `YYYY-MM` directories.
2. Sort month directories newest first. List months, newest first, until the
   first page (50 messages by default) is filled, merging in flat entries by
   id order.
3. Read the selected files (bounded concurrency, 6 in flight), parse and
   publish them to the timeline.
4. "Load older" repeats step 2–3 from where the previous page stopped, listing
   the next older month when the current one is exhausted.

Listings and contents are cached by object id for the session, so paging and
re-polling never download the same object twice. Private repository contents
stay in memory only. The public demo has a separate guarded cache for immutable
public blobs.

## 5. Chat rendering

- **Order and grouping.** Messages sort by id. The default view is a single
  timeline with a day separator per date; a topic sidebar lists topics by most
  recent activity with a count of messages that arrived since the view opened,
  and selecting a topic filters the timeline. Consecutive messages from the
  same sender in the same topic within 10 minutes form one group with a single
  header.
- **Channel layout.** Every message is a left-aligned row: an avatar and a
  colored name above each group, then one row per message with a compact meta
  line (time, type badge, recipient chips). The conversation is capped at a
  readable width and rows have no bubbles, so there is little vertical dead
  space. The chat-bubble layout is a possible later display mode that reuses
  the identity and color settings below. The original request placed the
  viewer's own messages on the right in a bubble; the maintainer chose the
  channel layout first, so that is intentionally not implemented here. The
  "You" tag, the accent bar and the `data-own` marker are what carry the
  identity in this layout.
- **Viewing as.** The toolbar offers the repository's participants (from the
  marker) plus "Observer". With a participant selected, that person's groups
  show a "You" tag and an accent bar, and messages that name the person in
  `to` are highlighted (a broadcast does not count). As Observer nothing is
  marked. The viewer never posts. The choice is saved per repository in
  guarded browser storage; a saved person who is not a participant is ignored
  (not forgotten). Without a saved choice the default is the first of the
  settings' "my names" that is a participant, else Observer. The demos keep
  the choice in memory only and do not touch browser storage.
- **Person colors.** Each person gets one of eight palette slots (`--person-N`,
  a value per theme). The default follows roster order, then former
  participants, then other senders by name, and wraps around after eight. The
  "Profile & colors" panel lets the user pick another slot and set a local
  display name per person; Reset restores both. Overrides are stored by person
  name, so a roster change keeps them. Two people can never look alike: when a
  display name equals another person's shown name or participant name, the
  participant name is appended in parentheses, in the sender labels, the
  "Viewing as" options and the recipient chips. Nothing is written to the collaboration
  repository, and every storage access is guarded so the view works without
  storage. Every person color reaches WCAG AA (4.5:1) as a name on the canvas,
  the conversation and the profile panel, and under the avatar text, in both
  themes; `tests/theme-contrast.test.ts` fails on a color that does not.

  Decisions recorded here so they are not re-opened: the Paper slots 1 and 5 are
  `#af4e1c` and `#0a7685`, slightly darker than the first proposal because
  `#c0561f` and `#0b7c8c` fall below 4.5:1 on the panel and canvas; Night Owl
  slots 4 to 8 are `#82aaff`, `#7fdbca`, `#ef5350`, `#ffcb8b` and `#8ba1b8`
  (slots 1 to 3 are `#f78c6c`, `#addb67`, `#c792ea`); names are not rendered on
  the toolbar surface, where Night Owl `#ef5350` would be below 4.5:1; the
  toolbar uses text buttons, with Refresh leftmost.
- **Header.** Sender, recipients (`to`), topic chip, time, and a type badge
  (`question`, `answer`, `info`, `decision-needed`, `ack`). `needs` shows as a
  highlighted line unless it is `none`. `due` shows as a date chip, marked
  overdue when the date has passed and no `answer` replies to the message.
- **Replies.** A message with `reply_to` shows a one-line quote of the parent
  (sender and first body line) that scrolls to the parent. If the parent is
  not loaded yet, the quote shows the parent id and a "load older" action.
  A plain `ack` (empty, "Received." or an `Expected reply: ...` line only)
  whose parent is loaded is not a row of its own; it is a receipt (see below).
  An `ack` with any other text keeps its own row so nothing is lost, and still
  counts as the sender's acknowledgement. An orphan `ack` (parent not loaded)
  renders as a compact row, with an "acknowledged" chip when its body is empty.
- **Receipts.** Under a question, a decision request or any acknowledged
  message: one line per plain acknowledgement (who, time, and the ETA when a line
  starts with `Expected reply: ...`, at most 100 characters), a question's derived state and progress
  (`2/3 answered`, from `deriveQuestionStates`, never re-derived in the UI),
  the conclusion text of a concluded question, and a "Recipients" disclosure
  that lists every recipient as answered (with time), acknowledged (with time)
  or "no acknowledgement yet"; the latest ack of a person (highest id) decides
  their state. For a question the list is the derived eligible answerers, so
  it always matches the `N/M` count (no duplicates, sender, former participants
  or people outside the roster). Broadcast recipients are the roster without the
  sender and former participants, and are unknown while the roster is. An
  acknowledgement is an explicit reply message; the repository does not record
  who merely opened a message, so there is no read receipt and the panel says
  so. A message that nobody acknowledged and that asks for no answer shows no
  receipts.
  Decisions recorded so they are not re-opened: the sender and send time are
  the message row itself, so "sent" is not repeated as a per-recipient state;
  the ETA is read from `Expected reply: ...` in the ack body; and the message
  detail is an inline "Recipients" disclosure, not a side panel, so it works
  the same on phone and desktop.
- **Questions view.** The conversation list has a "Questions" entry that lists
  every question grouped as open, concluded and answered (plus "not yet
  known" while the roster or a topic is incomplete), newest first. Open
  questions the viewer ("Viewing as") still has to answer are marked "Waiting
  for you" and listed first. Choosing a question opens its topic at that
  message.
- **Refs and attachments.** Each `refs` entry becomes a chip under the body.
  A safe `topics/` path (repository-relative segments only; no `.`, `..`,
  empty segments, backslashes, `%` escapes or control characters) is a file
  card with a type badge (MD, TXT, CSV, IMG, FILE) and its name. Opening the
  card reads its directory listing once per revision, for the size, so a long
  thread makes no request until a card is opened; the card then shows the size,
  the path and an "Open in GitHub" link from the source
  (`MessageSource.webLink`) to the file at the revision being viewed, which keeps provider details out of the UI. A
  message id jumps to and highlights that message (`:target`), a URL shows its
  host and opens in a new tab with `rel="noopener noreferrer"`, and anything
  else stays plain text. The **Files** entry lists every file and link
  referenced in the current conversation (all topics or the selected one),
  newest reference first. It lists only loaded messages: it shows the same
  "Load older messages" control as the chat and a note while older pages are
  not loaded, so attachments of older messages are not silently missing.
  Inline previews of Markdown, text, CSV and images
  are a later slice.

  Out of scope (follow-up): a "sidecar note" for data files, because the
  repository documents no naming convention for it; it is not invented here.
- **Body.** Plain text with preserved line breaks. No Markdown-to-HTML and no
  `innerHTML`: message text cannot inject markup.
- **States.** `locked` bodies show a lock placeholder ("Encrypted message.
  This version cannot decrypt it yet"); malformed files show the malformed
  card; messages with `issues` show a warning marker with the list.

## 6. Credentials

Two different secrets with different purposes:

| Secret | Purpose | Required |
| --- | --- | --- |
| Access credential | read a private repository through the provider API | private repositories only |
| Private key | decrypt encrypted message bodies (age identity) | no (_later_; the settings screen does not accept or store one until a decryptor exists) |

- **Scope.** GitHub: a fine-grained personal access token with access to
  "Only select repositories" (exactly the collaboration repository) and the
  repository permission **Contents: read-only** (Metadata read-only is added
  automatically). An expiry date is recommended. GitLab (_later_): a project
  access token with `read_repository` (and `read_api` if the instance
  requires it for the tree endpoint), role Reporter.
- **Storage.** Tauri builds store secrets only in the OS credential store: the
  macOS Keychain and the Android Keystore (an encrypted entry whose key never
  leaves the Keystore). The web build has no keychain; it offers two choices
  with a visible warning:
  1. **Memory only** (default): the token lives for the page session and must
     be entered again after reload.
  2. **Encrypted in this browser**: the token is encrypted with AES-GCM under a
     non-extractable WebCrypto key; key and ciphertext stay in IndexedDB for
     this origin. This avoids a plain-text token in site storage (for example
     when site data is inspected or exported), but the browser keeps the key in
     the same profile, so a copy of the profile can decrypt it, and script in
     the same origin or someone with the unlocked profile can use it. The
     warning says so.

     The key is created on the first save. Two tabs saving for the first time
     at the same moment can each create a key; the later write wins and the
     token saved by the other tab can no longer be decrypted. It then reads as
     missing and the settings screen asks for the token again.
- **Endpoint binding.** The stored token record carries the endpoint it was
  saved for, and a token is only used for that endpoint. Changing the endpoint
  requires entering a token again, so a mistyped or different host never
  receives the stored token, whatever the order in which settings and the
  token were written. Stored settings are checked again on load with the same
  endpoint and repository rules as the settings screen.
- **Store failures.** A credential store that cannot be read (for example
  blocked browser storage) counts as holding no token: choosing a saved
  repository falls through to the settings screen. Saving still succeeds when an old copy in the other
  store cannot be removed, and the viewer shows a warning; removing
  credentials tries every store and reports one it could not clear.
- **Never exposed.**
  - Secrets are wrapped in a `Secret` type whose `toString`, `toJSON` and
    inspection return `[redacted]`; only the HTTP layer reads the raw value to
    build the auth header.
  - Never in URLs (no `access_token` query parameter), never logged, never in
    error messages, never in application state that is serialized or
    persisted (settings persist only non-secret fields).
  - In the DOM only as a masked `type="password"` input while the user types it.
    After saving, settings show "configured" and a replace/remove action, not
    the value or a fragment of it.
  - The production build carries a Content Security Policy:
    `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'self' https:`.
    The browser build cannot know the configured endpoint when it is built,
    so `connect-src` allows same-origin requests and any `https:` origin; packaged builds narrow it to
    the configured endpoint. The dev server runs without it because hot
    reload uses inline scripts. No third-party scripts, fonts or analytics.
- **In-memory lifetime.** When a user chooses a saved repository, its token is
  read from the store (or entered), handed to the source, and held in the source's closure for the
  app session. Changing the repository, removing the credential or signing
  out drops the source and the reference. A `401` stops polling and asks for a
  new credential instead of retrying.
- **Public live demo.** The welcome and settings screens open a same-origin
  snapshot of the public demo repository. The Pages workflow builds the
  snapshot with its read-only workflow token on main updates, every six hours,
  and on manual runs; the token is not included in the generated file or web
  bundle. Opening the snapshot makes no GitHub API requests. The live demo does
  not read saved settings or credentials. Only the public demo source may cache
  immutable blobs in guarded browser storage; private repository content
  remains in memory only. The transition rules below keep the page from
  hammering the API or showing mixed data.

  _Copies._ A demo viewer shows exactly one copy: the snapshot, the bundled
  sample, or the live repository. A copy is read completely before it replaces
  another, so a viewer never merges items from two copies and nothing is
  filled in from the previous one.
  A live copy is complete when its open succeeded and no file of the loaded
  page is unavailable. A copy missing even one message counts as a failed
  check and never replaces a copy that has it.

  _Opening._ Open the snapshot first. Only when it is missing or malformed
  does the page ask the API, once and only if the request gate allows it; if
  the API fails, the bundled sample is shown.

  _Checking._ **Check live now** is the only way from a static copy to the live
  repository, and only an explicit click starts it. Navigating, re-rendering and
  reopening the demo never start a check. A successful check replaces the
  static copy with the live repository, which is always at least as new as the
  snapshot. A failed check (rate limit, network error or an invalid
  repository) changes nothing but the notice, which names the copy still shown
  and the time of the next check.

  _One-way._ After a live copy was shown, the page does not go back to the
  snapshot or the bundled sample in that page session: reopening the demo or
  cancelling out of settings shows the live copy again. If a later poll hits a
  rate limit, the live items stay on screen with the error banner and the poller
  retries after the reset.

  _Request gate._ One gate per page session spaces every anonymous API request
  made for opening or checking. It closes when a request starts, so a second
  open or check cannot run in parallel. It then stays closed for at least five
  minutes after any request, and after a rate-limit response until the reset
  time the API reported (`Retry-After`, or `X-RateLimit-Reset` when there is no
  `Retry-After`), or 15 minutes when it reported none. While the gate is closed
  a click on **Check live now** makes no request and only explains when the
  next check is possible. The gate lives in memory; reloading the page starts a
  new session.

  _Strictness._ This is the chosen trade-off: a blob that stays unreadable, for
  example one that is permanently missing or over the size limit, makes every
  live check fail, so the page keeps showing the snapshot until the repository
  is fixed. A complete older copy is preferred to a newer incomplete one.

## 7. Polling and notifications

- **Poll target.** One conditional `head` request per interval. `not-modified`
  ends the cycle. A new revision lists `inbox/` and the newest month
  directory, diffs entry names against what is known, and reads only the new
  files. A new month directory is picked up because `inbox/` itself changes.
- **Interval.** 60 seconds while the window is visible, 5 minutes while
  hidden. The public demo does not poll GitHub while showing a static copy.
  When it shows the live repository, anonymous demo sessions use a five-minute
  interval whether visible or hidden. Manual refresh is limited to that same interval and replaces the
  next scheduled poll, so it cannot add another poll during the interval. Each
  anonymous API request still counts against the per-IP limit, including a
  `304 Not Modified`; ETags reduce transfer and avoid fetching unchanged
  history. A changed repository can require additional requests. Refresh and
  Load older wait until the reset time after a rate-limit response. Errors back off exponentially
  (doubling, capped at 15 minutes); `rate-limited` waits until `retryAt`; when
  the remaining budget drops below 10 % of the limit the interval stretches so
  the budget lasts until the reset. Opening the repository counts as the
  first poll: an open error that needs the user stops polling, and a
  rate-limited open waits for `retryAt`. When the window becomes visible the
  schedule is recomputed at once, so a poll that is due under the visible
  interval runs immediately.
- **Notifications.** Local only, while the app runs: the Web Notifications API
  (permission requested from a user action) in the browser and the Tauri
  notification plugin in packaged builds. A notification names the sender and
  topic, never the body, so message content does not appear on a lock screen.
  Messages from "my names" do not notify. Background push is out of scope
  because it needs a server.

## 8. Encrypted bodies (_later_)

The encrypted-message format of the collaboration method is not settled yet.
This slice reserves:

- **Detection.** A body whose first non-blank line is
  `-----BEGIN AGE ENCRYPTED FILE-----` is parsed as `locked`, keeping the
  armored text. The marker may change when the format is settled; only the
  parser's detection function changes then.
- **Interface.**

  ```ts
  interface BodyDecryptor {
    decrypt(armored: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  }
  ```

  The decrypted text goes through the same body rules (line split, five-line
  check) and becomes `decrypted` or `undecryptable`.
- **Implementation.** age in the client with typage (`age-encryption` on npm),
  using the private key from the credential store. Decrypted text stays in
  memory only. The decryption slice adds the `private-key` entry to the credential
  store and the private key field to the settings screen.

## 9. Packaging (_later_)

- Tauri v2 wraps the same web build for macOS and Android. Packaged builds use
  the Tauri HTTP plugin (scoped to the configured endpoint) instead of
  `fetch`, which removes CORS limits for self-hosted GitLab and uses the OS
  trust store.
- Secrets go through a credential-store adapter backed by the macOS Keychain
  and the Android Keystore. The plugin or crate is chosen in the packaging
  slice; the web code depends only on the `CredentialStore` interface.
- Notifications use the Tauri notification plugin.
- Signing is the maintainer's responsibility: Apple Developer ID signing and
  notarization for macOS, the Android release keystore for the apk. No signing
  material is ever committed or handled by agents.

### Known limits for later slices

- The repository field accepts only `owner/repository`. GitLab nested groups
  (`group/subgroup/repository`) need a wider rule with the GitLab source.
- `CredentialStorage` is a closed union of the two browser choices; packaged
  builds add a keychain value and the settings screen offers it there.
- The Tauri HTTP plugin must honour the request options the GitHub source
  relies on (`redirect: "error"`, `cache: "no-store"`,
  `credentials: "omit"`); verify this in the packaging slice.
- The meta CSP of the browser build does not fit the Tauri build as is: it
  must also allow the IPC origins that the HTTP and keychain plugins use.
  Check this in the packaging slice.

## 10. Testing strategy

- **No network in tests.** Unit tests run on fixtures only. Providers are
  tested with an injected `fetch` that returns recorded-shape responses; any
  unexpected request fails the test.
- **Fixtures are synthetic.** Placeholder participants (`alice-agent`,
  `bob-agent`), placeholder topics and hosts (`gitlab.example.com`), no real
  message content, and no tokens. Tests use an obvious fake token value and
  assert it never appears in errors or serialized state.
- **Layers.**
  - Parser: table-driven tests for every fatal and non-fatal rule, CRLF input,
    locked bodies.
  - Loader: fixture source with flat, monthly and mixed layouts; paging order;
    change detection; a download failure for one file.
  - Providers: conditional requests and `304`, rate-limit parsing and
    `rate-limited` errors, tree walking, `truncated`, error-kind mapping.
  - UI: render tests of the chat view from fixtures, including a malformed
    file and a locked message.
- One validation command (`pnpm check`) runs formatting, lint, type check,
  tests and the production build.

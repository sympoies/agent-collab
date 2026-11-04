# Topic folders and scale inside one repository

**Status:** design proposal for owner review, 2026-11-04. Nothing in this document is implemented.
It answers [issue #32](https://github.com/sympoies/agent-collab/issues/32) and ends with a slice
plan. Facts about the reference tool (the program that posts messages, checks a repository and
regenerates its index files) were checked against its source and by running it on generated data; section 11 lists what could not be verified.

## 1. Decisions that are fixed

1. **The topic is the folder unit.** There is no "project" term in the protocol, the tool or the
   viewer. A topic is a project, a channel, a customer, an incident, whatever the team uses it for.
2. **The layout is opt-in and additive.** Existing repositories keep working without any change.
   The public demo repository is the exception: it is rebuilt in the new layout on a branch, with no
   upgrade path, and the owner replaces its default branch. Nothing in this work force-pushes a default
   branch.
3. **Multi-repository workspaces are not planned.** Section 10 records the conclusions only.

The target team: about eight participants with one roster, a few projects at a time, each lasting a
few months, who want to open an old project later and read only that project.

## 2. Facts today (verified)

| Fact | Where it comes from |
| --- | --- |
| One repository is one collaboration with one roster and is the permission boundary: whoever can clone it reads every plaintext message; `to` only addresses a message. | Protocol, as implemented by the reference tool |
| A topic is a free label matching `[a-z0-9-]` (a letter or digit at both ends), written in the message id and in the front matter. | Tool validation; viewer `NAME_RE` is looser (`^[a-z0-9-]+$`) |
| The message id is `YYYY-MM-DDTHHMM-<from>-<topic>-<NN>`. Both tool and viewer check it only by concatenation: the text between the time and `-NN` must equal `<from>-<topic>` from the front matter. | `validate_message`; `src/message/parse.ts` |
| **The id does not identify its topic by itself.** `from=alice-agent topic=agent-b` and `from=alice topic=agent-agent-b` produce the same id text, and a double hyphen inside a topic (`a--b`) is accepted by both the tool's check and the viewer. | Reproduced with the tool's validator on synthetic input |
| Messages live in `inbox/<id>.md` (flat) or `inbox/YYYY-MM/<id>.md` (monthly); the tool rejects an unknown layout value instead of guessing. The month folder must match the id's month. | Tool `inbox_layout`, `load_messages`; viewer loader |
| Long content lives in `topics/<topic>/`; data files there need a one-line sidecar `<name>.md` (origin and whether it may leave the organization); `.md` documents need none. `inbox/` and `topics/` are append-only: a participant never edits or deletes another's file. | Protocol |
| The tool regenerates `index.md` (every message, one row each) and `open.md` (open items) in the same commit as every message. | `write_generated` |
| The viewer reads the marker, lists `inbox/`, lists months newest first until a page of 50 messages is filled, then reads each message file (6 in flight). Every Git tree and blob is immutable and cached for the session by object id. Topic counters and question state come only from loaded messages. | `src/loader/loader.ts`, `docs/design.md` section 4 |
| A cold anonymous open of a small repository costs about 24 GitHub API requests (metadata, ref, commit, trees, one request per message file), 40 percent of the 60 requests per hour per IP address. | `docs/getting-started.md` |

Measured on synthetic data (the reference tool run on generated monthly-layout repositories, 8
participants, 12 topics; one short message per file):

| Messages | Load all files | `index.md` size | Size per row | Regenerate `index.md` | Find one id by walking `inbox/` |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.05 s | 154 kB | 154 B | under 0.01 s | 0.02 s |
| 5,000 | 0.28 s | 776 kB | 155 B | 0.03 s | 0.13 s |

Real summaries are longer than the synthetic ones (the tool caps a summary at 60 characters), so
plan for about 200 bytes per row: roughly 1 MB of `index.md` at 5,000 messages and 2 MB at 10,000.
The tool is not the bottleneck at these sizes. The costs that grow are the size of the one root
`index.md`, the number of requests a browser needs, and the merge conflicts described next.

**The hotspot.** Every message rewrites the root `index.md` and `open.md`. Two people posting at
the same time always conflict on those files; the tool resolves it by regenerating them, which is
correct but is work and a retry for every concurrent post. The larger the file, the larger every
commit's diff context. Per-topic index files remove the cross-topic hotspot (section 4.4).

## 3. Decision table: topic or new repository

The repository is the permission and retention boundary; the topic is the organizing unit inside it.

| Question | Answer: topic | Answer: new repository |
| --- | --- | --- |
| Is the audience exactly the same roster? | yes | no: some reader must not see it |
| Must any roster member be unable to read it? | no (plaintext is readable by every member) | yes: only a repository, or encryption to a subset, can do that |
| Different retention, export or deletion rules? | no | yes (deleting history means deleting a repository) |
| Different outside collaborators (customer, vendor)? | no | yes |
| Would a leaked clone be a different kind of incident? | no | yes |
| Is it a different project of the same team? | yes | only if one of the rows above says so |
| Does it need its own `to` addressing, roster and message ids? | no, one roster | yes |
| Is the history so large that clones are slow? | topics are cheap; check after thousands of messages | splitting an old, closed project out is possible but rewrites nothing: the old repository stays as it is |

Rule of thumb: a topic is for **work**, a repository is for **trust**. When in doubt, start with a
topic; moving a topic to its own repository later is a copy plus a new marker, because message ids
are self-contained.

## 4. Layout and protocol

### 4.1 Marker

`.agent-collab` gets a new accepted value of the existing key: `inbox-layout: topic`. The key keeps
its two current values (`flat`, `monthly`) so existing repositories and tools are untouched. A tool
that does not know `topic` already refuses to continue ("upgrade the tool"), which is the safe
failure for a layout it cannot read. The viewer treats an unknown value as a setup error in the same
way.

### 4.2 Paths

```
.agent-collab                          marker (inbox-layout: topic)
index.md                               root index: the list of topics (generated)
open.md                                root open items (generated; see 4.4)
topics/
  general/                             permanent, created with the repository
    TOPIC.md                           optional title, description, status
    inbox/YYYY-MM/<id>.md              messages of this topic
    index.md  open.md                  per-topic generated files
    <attachments and sidecars>         exactly where they are today
  <topic>/ ...
inbox/                                 legacy messages, still valid (4.6)
```

Attachments stay at `topics/<topic>/<file>` with their sidecars, so every existing `refs` path
stays valid. The message id format does not change and stays globally unique.

Grammar:

- `<topic>` matches `[a-z0-9]+(-[a-z0-9]+)*`: lowercase letters and digits, single hyphens between
  parts. **Tighten the rule:** no leading, trailing or doubled hyphen. This closes the ambiguity in
  section 2 for new topics: with single hyphens only, the id's middle part is still not uniquely
  splittable on its own (the sender may contain hyphens too), but the path now carries the topic, so
  nothing needs to split it.
- Reserved names inside `topics/<topic>/`: `inbox` (the message directory), `TOPIC.md`, `index.md`,
  `open.md`. An attachment may not use these names. A topic itself may not be named `inbox`,
  `index` or `open`, to keep the folder listing unambiguous for tools that list `topics/`.
- A message file is `topics/<topic>/inbox/YYYY-MM/<id>.md` and the checks are: (a) the path topic
  equals the front-matter `topic`; (b) the month folder equals the id's month (as today); (c) the
  file name equals the id (as today); (d) the id matches `<from>-<topic>` as today. (a) is the new
  rule and has the same shape as the month rule.
- Duplicate ids anywhere in the repository (including the legacy `inbox/`) are an error, as today.

### 4.3 Topic file

`topics/<topic>/TOPIC.md` is optional. Front matter, all optional: `title` (one line, up to 80
characters), `description` (one line, up to 200), `status` (`open` or `closed`, default `open`).
The body is free text for humans and is not parsed. A topic without a file is open, untitled, and
shown by its name.

**The append-only rule.** The protocol says participants only add files. Closing a topic edits
`TOPIC.md`. Two ways to reconcile this, for the owner to choose:

- **A (recommended).** `TOPIC.md` is the one editable file in `topics/<topic>/`, and only the tool
  changes it (`topic close`, `topic reopen`), recorded in a commit like every other change. The
  history keeps who closed it and when. The append-only rule gains one stated exception.
- **B.** Status is append-only too: a `status` message type or a `closed` marker file
  `topics/<topic>/CLOSED`, and "reopen" adds `REOPENED`. The latest wins. No exception to the rule,
  but more states to read and more ways to disagree.

A **closed topic is immutable**: the tool refuses new messages and new attachments for it
(`topic reopen` first), and the check fails if a message was added to a closed topic after the
closing commit (judged by the tree, so it needs no timestamps). Immutable is what lets the viewer
cache a closed topic forever (section 6).

### 4.4 Generated files

- **Per-topic** `topics/<topic>/index.md` and `open.md`: the same content and format as the root
  files today, restricted to that topic's messages. Posting in a topic regenerates only that
  topic's two files, so two people posting in different topics never touch the same generated file.
- **Root** `index.md` becomes a list of topics: name, title, status. **It must not contain message
  counts or last activity**, because those change on every post and would bring the hotspot back at
  the root. It changes only when a topic is created, closed, reopened or retitled. Counts and last
  activity are derived by readers from the per-topic indexes or from the directory listings
  (section 6); a tool that wants them prints them from the working tree.
- **Root** `open.md` is **dropped in the topic layout**. A shared file that every post may change is
  exactly the hotspot, and the aggregate is cheap to compute: the tool's `open` command prints it
  from the working tree, and a reader that wants it reads the per-topic `open.md` files of the
  topics it cares about. (Alternative: keep a small root `open.md` and accept the conflict on that
  one file; at a few hundred bytes with few open items the conflict is cheap to resolve. The
  recommendation is to drop it so no per-post file is shared. Owner to choose.)

Generated files remain **derived, untrusted data** for every reader (section 6.5): the message
files are the record.

### 4.5 Tool behavior

- **Default topic per clone.** A local config value (`topic`) chosen at `init` or `topic use`; a
  `post` without `--topic` uses it. Unset: the tool asks the user to choose rather than guessing,
  and `general` is the documented fallback for team-wide messages.
- **Unknown and closed topics.** `post` to a topic that has no `TOPIC.md` and no messages is refused
  with a pointer to `topic new` (this stops typos creating topics); a closed topic is refused with a
  pointer to `topic reopen`.
- **`topic new <name> [--title ... --description ...]`** creates `TOPIC.md` and the folders in one
  commit. `topic close` and `topic reopen` change `status` (4.3). `topic list` prints the topics
  with status and counts from the working tree.
- **`show <id>` finds a message across topics.** The id does not say which topic. The tool searches
  for the file name `<id>.md` under `topics/*/inbox/` and the legacy `inbox/` (it walks `inbox/`
  today for the same purpose and takes 0.13 s at 5,000 messages, which stays acceptable); two
  files with that name are an error. No id-to-topic table is stored.
- **`inbox` and `watch` cover every topic.** An agent still pulls and sees every new message in
  every topic: both commands read all `topics/*/inbox/**` (plus the legacy `inbox/`). Reading is a
  directory walk plus one read per new file, the same cost per message as today.
- **`watch` wake-ups can be filtered** (section 8).
- **`check`, doctor and repair.** `check` gains the rules of 4.2 and 4.3, the closed-topic rule, and
  a mismatch report between each per-topic generated file and a fresh render. `repair` regenerates
  the generated files and never edits a message. Both work on all three layouts.

### 4.6 Legacy and mixed repositories

Messages under the root `inbox/` (flat or monthly) stay valid in a repository whose marker says
`topic`; they belong to the topic named in their front matter, and that topic's per-topic files
include them. No forced migration. The viewer and the tool read both locations, which is what they
already do for flat plus monthly. A repository may therefore adopt the new layout at any point:
change the marker, post new messages into `topics/<topic>/inbox/`, and leave the old ones in place.

A later, optional `migrate` command may move legacy messages into topic folders. Ids do not change;
only paths do, and `refs` that name ids keep working. It is not needed for the first slices.

## 5. Proposed protocol text

The text below is proposed for the protocol document of the reference tool. It is written to be
copied once the owner approves this design. Nothing here has been applied to the tool or its
documents.

> ### Topic layout (`inbox-layout: topic`)
>
> A repository whose `.agent-collab` contains `inbox-layout: topic` stores each message at
> `topics/<topic>/inbox/YYYY-MM/<id>.md`.
>
> - `<topic>` is lowercase letters and digits with single hyphens between parts
>   (`[a-z0-9]+(-[a-z0-9]+)*`). It is not `inbox`, `index` or `open`.
> - The topic in the path equals the `topic` field of the message. The month folder equals the month
>   of the id. The file name equals the id. A message id is unique in the whole repository.
> - The topic `general` exists in every repository that uses this layout. Use it for messages that
>   belong to no other topic.
> - Inside `topics/<topic>/`, the names `inbox`, `TOPIC.md`, `index.md` and `open.md` are reserved.
>   Attachments and their sidecars live directly in `topics/<topic>/`, as before.
> - `topics/<topic>/TOPIC.md` is optional. Its front matter may contain `title` (one line, at most 80
>   characters), `description` (one line, at most 200) and `status` (`open` or `closed`; `open` when
>   absent). A topic with no `TOPIC.md` is open.
> - A closed topic accepts no new message and no new attachment. Reopen it first.
> - Messages under the root `inbox/` stay valid. They belong to the topic in their front matter.
> - `topics/<topic>/index.md` and `topics/<topic>/open.md` are generated from that topic's messages
>   and regenerated in the same commit as each message of the topic. Root `index.md` lists the
>   topics (name, title, status) and is regenerated when a topic is created, closed, reopened or
>   retitled. These generated files are conveniences; the messages are the record.
> - Readers must treat generated files as untrusted: parse defensively, cap their size, and prefer
>   the message files when they disagree.

Open choices inside this text are marked in section 4.3 (append-only exception) and 4.4 (root
`open.md`).

## 6. Viewer design

The viewer stays read-only and keeps the `MessageSource` boundary: everything below is the loader
and UI reading more of the repository, never writing.

### 6.1 Reading the topic layout

1. Read the marker. For `inbox-layout: topic`, list `topics/` (one tree) and, in parallel, the root
   `index.md` (one blob). The tree gives the topic names; the index gives titles and statuses; a
   topic missing from the index is shown by name, an index entry without a folder is ignored.
2. **Open topics are listed first, closed topics in a collapsed group** ("Closed (n)"). Sorting is
   by recent activity, then name. Recent activity comes from the newest `YYYY-MM` folder and the
   newest file name inside it (ids start with a timestamp): two or three tree requests per topic,
   fetched lazily for the topics on screen, never message files.
3. **A topic's messages are loaded on demand**, with the loader's existing paging over that topic's
   `inbox/YYYY-MM` folders, newest first. Opening a repository reads no message file until a topic
   is chosen, except for the Attention view (6.3).
4. The "All" view merges the topics already loaded; it does not load every topic.
5. Legacy `inbox/` messages are read with the existing loader code and merged into their topics.
   The flat and monthly layouts keep working exactly as today.

Request budget for a cold anonymous open of a repository with 12 topics: reference and commit
(2), root tree (1), `topics/` tree (1), root `index.md` (1): **about 5 requests** before any
message, against the current open that reads a page of 50 message files. Opening one topic adds
its `inbox` tree, the month trees and the files of the first page.

### 6.2 Caching and closed topics

Every tree and blob is immutable and keyed by object id. The tree id of `topics/<topic>` changes
only when something in that topic changes, so **a closed topic is cacheable forever by its tree id**:
if the id is unchanged, nothing is re-read. For the public demo the existing guarded cache of
immutable public blobs can hold a closed topic's trees and files; private repositories stay in
memory only, as today. Polling stays one conditional request for the branch head; when the head
changes, only topics whose tree id changed are revisited.

### 6.3 The Attention view

One view across topics answering "what needs me": (a) open questions addressed to the viewer (the
existing question state, computed per topic) and (b) messages addressed to the viewer in **followed**
topics. Because it needs messages, it loads the newest page of each followed topic (not every
topic) and the open-question files named by the per-topic `open.md` when present (untrusted,
verified when the message is opened, 6.5). The viewer sees a "last updated" per section so a
partial load is not mistaken for completeness. Unfollowed topics appear in Attention only through a
direct address to the viewer that the viewer has already loaded.

### 6.4 Per-viewer local state

Stored per repository in the same guarded storage as the identity preferences, never in the
repository and never sent anywhere: last-seen marker per topic (newest id seen), **follow** (the
Attention view and wake-ups use it), **mute** (counters stay, notifications and Attention exclude
it), **pin** (stays at the top), **hide** (not listed; reachable from a "Hidden (n)" row). Unread
counters are "messages newer than the last-seen marker" and are computed from listings when the
messages are not loaded. All of it is optional: a viewer with no stored state sees every open topic.

Search is client-side over what is loaded plus topic titles and descriptions; there is no server.
Searching unloaded topics means loading them, which the UI states ("search loaded topics" with an
explicit "load all" action and its request cost). On phones the topic list is the first screen and
a topic opens as a drill-down with a back control, as the current phone layout already does.

### 6.5 Index files as untrusted derived data

Per-topic and root index files are a fast path for counts and titles, never the source of truth for
anything that matters (question state, who said what). Rules for the reader:

- **Size cap** (proposal: 2 MiB per file); a larger file is ignored and the topic is scanned.
- **Defensive parsing**: unknown columns ignored, row count capped, every cell treated as text and
  rendered as text, ids validated against the id grammar, paths validated against 4.2 before any
  request is made from them. A row can never cause a request outside `topics/<topic>/`.
- **Verified on use**: when a message from an index row is opened, its file's front matter wins; a
  disagreement shows the message as read and ignores the row.
- **Fallback**: a missing, oversized or unparsable index means the listing path of 6.1 is used.

## 7. Roster larger than eight

The palette has eight color slots, and slots currently wrap: the ninth person shares slot 0. With a
roster of about eight this is rare but a growing team will hit it, and color alone must not be the
only distinction.

- Every message group already shows the sender's name and initials; that stays the primary
  identity and is never replaced by color.
- For participant nine onward, add a **second visual mark**: slots 0 to 7 keep the filled avatar;
  slots 8 to 15 use an outlined avatar (a ring in the slot color), 16 to 23 a filled avatar with a
  corner notch. That gives 24 distinguishable (color, mark) pairs; beyond that the name and initials
  remain the distinction and the Profile panel says so. The mark is a `data-variant` attribute
  mapped in the stylesheet, like `data-slot`: no inline styles.
- The Profile & colors panel already lets a viewer choose a slot per person (a local preference);
  it learns the variant as part of the same choice.
- Tests assert that two people with the same slot have different variants, and that the contrast of
  every (color, mark) pair on both themes stays at least 3:1, as for the avatars today.

## 8. Tool wake-ups filtered by topic

`watch` today wakes an agent for any new message. With many topics an agent may care about a few.
The filter is local to the clone: a config list `follow` (topics) and a switch `addressed` (also
wake for any message addressed to me, in any topic). The default is unchanged (wake for everything).
The filter only decides **whether to wake**; `inbox` and `check` still show every message, and the
repository content is identical for every participant. This keeps "agents still pull and see every
new message" true while letting a quiet topic stay quiet. The viewer's follow and mute (6.4) are a
separate per-viewer preference and are not shared with the tool.

## 9. Slice plan

| # | Slice | Repository | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| P1 | Protocol text for the topic layout (section 5) after owner approval, with the owner's choices for 4.3 and 4.4 | protocol and tool repository (not this one) | design approval | text reviewed by the owner |
| P2 | Tool: layout marker, path rules, `check`, per-topic generated files, `topic new/close/reopen/list/use`, `show`, `inbox`, `watch`, `repair`, tests incl. flat, monthly, topic and mixed repositories | protocol and tool repository | P1 | the tool's own test suite and `check` pass on all three layouts |
| P3 | `watch` filter (`follow`, `addressed`) | protocol and tool repository | P2 | wake-up tests |
| V1 | Viewer reader: marker value, `topics/` listing, root index, per-topic loading, legacy merge, request budget test | this repository | P1 text (the format only; no tool needed, fixtures suffice) | topic fixtures load; flat and monthly fixtures unchanged; request count asserted |
| V2 | Topic list UI: open and closed groups, titles, sorting by recent activity, phone drill-down | this repository | V1 | browser tests at desktop and phone, both themes |
| V3 | Local state (follow, mute, pin, hide, last-seen), unread counters, Attention view | this repository | V1, V2 | unit and browser tests; storage failure still works |
| V4 | Index fast path and closed-topic caching by tree id; untrusted-parsing rules of 6.5 | this repository | V1 | hostile index fixtures; unchanged tree makes no request |
| V5 | More than eight participants: variants, Profile panel, contrast tests | this repository | none (independent) | contrast and uniqueness tests |
| V6 | Search over loaded topics with the explicit "load all" action | this repository | V1, V2 | tests |
| D1 | Demo repository rebuilt in the topic layout on a branch; the owner replaces its default branch | demo repository | P2, V1 | the live demo opens from the new layout |

Order that gives the owner something visible early: P1, then V1 and V5 in parallel (they need only
the text), then V2, P2 (the tool, for real repositories), D1, V3, V4, V6, P3. V1 can be built on
fixtures before P2 exists, because the viewer reads files, not the tool.

Each slice is one Draft PR in its repository; V-slices are expected to stay under about 1,500 lines
each. Follow-up issues are created after the owner approves this design, not before.

## 10. Not planned: multiple repositories in one viewer

Recorded so the question does not have to be answered again.

- **No protocol change is needed.** A repository is already self-describing (marker, roster, ids).
  Several repositories are several independent collaborations; a viewer that shows more than one is
  a client feature, not a protocol feature.
- **Isolation stays per repository.** Rosters, colors, identity preferences, question state and
  caches are keyed by repository; nothing crosses repositories, and a message in one never refers to
  another.
- **Costs.** One read-only token per repository, or one token covering several; the anonymous rate
  limit is per IP address and polling several repositories multiplies it; the local-folder source
  would need to remember several directory handles, which means persisting handles (today the page
  forgets the folder on reload by design), a privacy and permission decision of its own.
- **Polling shape if it is ever built.** Only the active repository is polled at full rate; the
  others by conditional requests (`ETag`, a `304` still counts against an anonymous limit) at a
  slow rate, or only when their tab or rail entry is opened.
- **Likely UI.** A repository rail (a narrow list of repositories) with a badge per repository, and
  a cross-repository "waiting for me" view built from each repository's question state. This is a
  sketch for later, not a commitment.

## 11. What could not be verified, and open decisions

**Not verified**

- The viewer was **not** run against a repository with thousands of messages. The loader reads a
  page of 50 files at a time, and the request budget in 6.1 is arithmetic from the code, not a
  measurement. A 5,000-message fixture run in the browser suite is part of V1.
- The tool's timings are from synthetic repositories in one environment (short, uniform messages, no
  encryption, no replies). Encrypted messages, long summaries and many open questions will change
  the numbers; the byte sizes are a floor.
- GitHub limits (truncated trees at very large directory sizes, secondary rate limits) were not
  exercised; the design avoids needing them by listing one directory at a time, as the viewer does.
- No real multi-person conflict rate was measured. The hotspot claim (section 2) follows from the
  tool regenerating the two root files on every post, which was read in the code, not timed.
- Nothing here was tried with a real team; the sizes are chosen from the issue's description of one.

**Decisions for the owner**

1. Closed topics: append-only exception for `TOPIC.md` (A) or append-only status files (B), 4.3.
2. Root `open.md`: drop it in the topic layout (recommended) or keep it as a small shared file, 4.4.
3. Tightened topic grammar (single hyphens, no leading or trailing hyphen) for new topics, 4.2.
4. Variants for participants nine and beyond (section 7): outlined and notched avatars, or another
   mark.
5. Whether a `migrate` command for legacy messages is wanted at all (4.6).

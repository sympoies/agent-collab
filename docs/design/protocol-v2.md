# Collaboration protocol v2: what the viewer reads

Protocol v2 is a refinement of the topic layout ([topics-and-scale.md](topics-and-scale.md)). It
moves attachments into month folders and splits the per-topic index by month, so neither a topic's
top level nor its `index.md` grows without bound. This page states what the viewer reads; the tool
side defines how the files are written.

## Marker

`.agent-collab` starts with `collab-protocol: 2` and must say `inbox-layout: topic`. The viewer
accepts protocol 1 (every layout) and protocol 2 with the topic layout. Protocol 2 with any other
layout, and any other version, is the usual "unsupported collaboration protocol" setup error.

## Topic folder

```
topics/<topic>/
  TOPIC.md  index.md  open.md
  inbox/YYYY-MM/<id>.md                messages (unchanged)
  files/YYYY-MM/<name>                 attachments
  files/YYYY-MM/<name>.md              one-line sidecar of a data file
  index/YYYY-MM.md                     full index table of one month
```

- Messages are read from `inbox/YYYY-MM/` only, exactly as in v1. Nothing under `files/` or
  `index/` is ever loaded as a message.
- `refs` already carry the full repository path (`topics/<topic>/files/2026-11/x.csv`), so
  attachment cards resolve and open them as before: the reader lists the file's own folder and
  finds the entry.
- `TopicSession.files(topic, month?)` lists one month of `files/YYYY-MM/` (newest month first when
  none is given) and names the next older month. A `<name>.md` next to an existing `<name>` is that
  file's sidecar: it is attached to the file, not listed as a file. Only listings are requested; no
  file is downloaded. A folder under `files/` that is not `YYYY-MM` is ignored. In a v1 repository
  this returns null and nothing new is listed. The Files view still lists the files referenced by
  loaded messages; it does not use this listing yet.

## Month-split index

`topics/<topic>/index.md` keeps the v1 table format but holds only the recent rows (the newest
month, at least 200 rows), followed by links to `index/YYYY-MM.md`. Each month file holds the full
table of its month.

- **Fast path.** The topic digest still reads `index.md` alone: the newest id (topic sorting,
  Attention ranking) and the recent ids come from it, at the same one request per topic.
- **Counts.** When `index.md` links a month older than its newest row, its rows are only the recent
  part. The digest then reports `count: null` and `idsComplete: false` instead of a partial number,
  and does not read the month files to compute a total: nothing in the viewer shows a total count,
  so reading every month file for it would cost requests for no visible result. An unread count is
  given only when the recent ids reach back to the viewer's last-seen marker (every newer id is then
  among them); otherwise the topic is unread without a number. A v2 `index.md` without older links
  is counted exactly like v1.
- **Paging back.** `TopicSession.olderIndexRows(topic, before)` returns the rows older than an id
  from the newest `index/YYYY-MM.md` that has any. Month files are found by listing `index/`, never
  by following a link from `index.md`, and are read only when asked for, once per object id.
- **Untrusted.** Each month file gets the same rules as any generated file (design 6.5): the 2 MiB
  size cap (a larger file is skipped, not read), the row cap, plain-text cells, id grammar checks,
  and a row whose id is not in the file's month is dropped. The links in `index.md` only decide
  whether its rows are complete; no request is built from them.
- In a v1 repository `index.md` is read exactly as before, links in it are ignored, and
  `index/` is never listed.

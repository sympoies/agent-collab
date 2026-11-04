// What the viewer reads of a topic-layout repository before any message
// (docs/design/topics-and-scale.md, section 6.1): the layout marker, the `topics/` listing and the
// root topic index. A topic's messages are read later, through `topicLoader`.

import {
  isKnownLayout,
  isTopicFolderName,
  markerLayout,
  MAX_INDEX_BYTES,
  parseRootIndex,
  type TopicSummary,
} from "../message/topic-layout";
import { TopicLayoutSource } from "../source/topic-layout";
import { SourceError, type Head, type MessageSource } from "../source/types";
import { Loader, SetupError, type LoaderOptions } from "./loader";

const MARKER_FILE = ".agent-collab";
const SUPPORTED_PROTOCOL = "collab-protocol: 1";

export interface TopicList {
  /** Commit revision used to read the folder and index entries. */
  readonly revision: string;
  /** The already-read branch head, reused if this turns out to be a flat or monthly repository. */
  readonly head: Head;
  /** `topic` for the layout this reader serves; other layouts have no topic list. */
  readonly layout: string;
  /** Open and closed topics with a folder, then legacy-only topics; sorted by name within each. */
  readonly topics: readonly TopicSummary[];
}

/**
 * Reads the marker, lists `topics/` and reads the root `index.md`: about six API requests for a
 * GitHub repository, whatever the number of topics and messages. A repository in another layout
 * answers with an empty list.
 */
export async function readTopicList(source: MessageSource): Promise<TopicList> {
  const head = await source.head(null);
  if (head === "not-modified") throw new SourceError("unexpected", "");
  const root = await source.listDirectory(head.revision, "");
  const marker = root.find((entry) => entry.kind === "file" && entry.name === MARKER_FILE);
  if (marker === undefined) {
    throw new SetupError(`not a collaboration repository (no ${MARKER_FILE} marker)`, "no-marker");
  }
  const text = await source.readFile(marker);
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine !== SUPPORTED_PROTOCOL) {
    throw new SetupError(`unsupported collaboration protocol: ${firstLine}`, "protocol", firstLine);
  }
  const layout = markerLayout(text);
  if (!isKnownLayout(layout)) {
    throw new SetupError(`unsupported inbox layout: ${layout}`, "layout", layout);
  }
  if (layout !== "topic") return { layout, revision: head.revision, head, topics: [] };

  const folders = await listOrEmpty(source, head.revision, "topics");
  const index = root.find((entry) => entry.kind === "file" && entry.name === "index.md");
  // A missing, oversized or unreadable index only costs the titles; the listing still works.
  const rows =
    index === undefined || (index.size ?? 0) > MAX_INDEX_BYTES
      ? []
      : parseRootIndex(await source.readFile(index).catch(() => ""));
  const byName = new Map(rows.map((row) => [row.name, row]));

  const withFolder: TopicSummary[] = folders
    .filter((entry) => entry.kind === "directory" && isTopicFolderName(entry.name))
    .map((entry) => {
      const row = byName.get(entry.name);
      return {
        name: entry.name,
        title: row?.title ?? null,
        // A folder is not legacy-only, whatever a stale index row says.
        status: row?.status === "closed" ? "closed" : "open",
        folder: true,
      };
    });
  const folderNames = new Set(withFolder.map((topic) => topic.name));
  // An index row without a folder counts only as a legacy-only topic; any other is ignored.
  const legacyOnly: TopicSummary[] = rows
    .filter((row) => row.status === "legacy" && !folderNames.has(row.name))
    .map((row) => ({ name: row.name, title: row.title, status: "legacy", folder: false }));
  const byOrder = (a: TopicSummary, b: TopicSummary) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  return {
    layout,
    revision: head.revision,
    head,
    topics: [...withFolder.sort(byOrder), ...legacyOnly.sort(byOrder)],
  };
}

async function listOrEmpty(source: MessageSource, revision: string, path: string) {
  try {
    return await source.listDirectory(revision, path);
  } catch (error) {
    if (error instanceof SourceError && error.kind === "not-found") return [];
    throw error;
  }
}

/**
 * A loader for one topic: its folder `topics/<topic>/inbox/YYYY-MM`, paged newest first like any
 * other, plus the legacy messages that name the topic. Nothing else of the repository is listed.
 * Legacy files are matched by name first (a hint) and kept only if the message says this topic, so
 * a page can hold a few fewer messages than its size when the hint matched a different topic.
 */
export function topicLoader(
  source: MessageSource,
  topic: string,
  options: LoaderOptions = {},
): Loader {
  return new Loader(new TopicLayoutSource(source, { topic }), {
    ...options,
    // A legacy file name cannot say exactly which topic a message has (an id ending in -api may
    // be topic api or x-api), so the view keeps only messages whose parsed topic is this one.
    keep: (item) => item.kind !== "message" || item.message.topic === topic,
  });
}

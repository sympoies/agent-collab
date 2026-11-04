// Pure rules of the live-demo snapshot (scripts/create-demo-snapshot.mjs), kept free of network
// and file access so tests can run them: which repository paths enter the snapshot, how a blob is
// read (text, or listed without content), and the size limits that make a build fail clearly.

/** A file larger than this is listed without its content. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** The serialized snapshot every visitor downloads; larger fails the build. */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
/** Files in one snapshot; a repository with more is not a demo. */
export const MAX_SNAPSHOT_FILES = 5000;

const MARKER = ".agent-collab";
const TOPIC_MESSAGE = /^topics\/[^/]+\/inbox\//;

/**
 * Whether a repository path belongs in the snapshot: the marker, the root `index.md` (the topic
 * list of the topic layout), messages in the root `inbox/`, and everything under `topics/`
 * (topic messages, generated files, TOPIC.md and attachments).
 */
export function isSnapshotPath(path) {
  // A path the viewer's snapshot parser would refuse (empty, ".", ".." or absolute) fails here,
  // at build time, rather than as a broken page.
  if (
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return false;
  }
  return (
    path === MARKER ||
    path === "index.md" ||
    (path.startsWith("inbox/") && path.endsWith(".md")) ||
    path.startsWith("topics/")
  );
}

/** Whether a git tree entry is a regular file at a snapshot path (symbolic links never are). */
export function isSnapshotEntry(entry) {
  return (
    entry?.type === "blob" &&
    entry.mode !== "120000" &&
    typeof entry.sha === "string" &&
    typeof entry.path === "string" &&
    isSnapshotPath(entry.path)
  );
}

/**
 * Attachments keep a listing-only entry when their content is not included, so a message's
 * `refs` still resolve; marker, index and message files do not (a message the viewer cannot read
 * is worse than a missing one). A topic's TOPIC.md, generated files and attachments all fall in
 * the first group: an unreadable TOPIC.md is not read by the viewer today, and `parseTopicFile`
 * treats an unreadable one as an open topic without a title.
 */
function keepsListing(path) {
  return path.startsWith("topics/") && !TOPIC_MESSAGE.test(path);
}

/** The UTF-8 text of a blob, or null for binary data (a NUL byte, or bytes that are not UTF-8). */
export function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function omitted(path, size) {
  return { path, text: "", omitted: true, size };
}

/**
 * Builds the snapshot of a repository tree. `readBytes(entry)` returns the bytes of a blob; it is
 * not called for a file whose listed size is over the limit. Throws, with the reason, when the
 * marker is missing or a limit is exceeded, so the page is never deployed with a broken demo.
 */
export async function assembleSnapshot({ entries, readBytes, revision, generatedAt }) {
  const selected = entries
    .filter(isSnapshotEntry)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (!selected.some((entry) => entry.path === MARKER)) {
    throw new Error("The live-demo collaboration marker is missing.");
  }
  if (selected.length > MAX_SNAPSHOT_FILES) {
    throw new Error(
      `The live-demo repository has ${String(selected.length)} snapshot files; the limit is ${String(MAX_SNAPSHOT_FILES)}.`,
    );
  }
  const files = [];
  for (const entry of selected) {
    const listed = typeof entry.size === "number" ? entry.size : null;
    let text = null;
    let size = listed;
    if (listed === null || listed <= MAX_FILE_BYTES) {
      const bytes = await readBytes(entry);
      size = bytes.length;
      text = size <= MAX_FILE_BYTES ? decodeText(bytes) : null;
    }
    if (text !== null) files.push({ path: entry.path, text });
    else if (keepsListing(entry.path)) files.push(omitted(entry.path, size ?? 0));
  }
  const snapshot = { schemaVersion: 1, generatedAt, revision, files };
  const json = JSON.stringify(snapshot);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `The live-demo snapshot is ${String(bytes)} bytes; the limit is ${String(MAX_SNAPSHOT_BYTES)}. Reduce the demo repository or raise the limit in scripts/demo-snapshot-rules.mjs.`,
    );
  }
  return { snapshot, json };
}

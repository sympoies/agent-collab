// Builds the hosted-deployment snapshot of a local clone (scripts/create-folder-snapshot.mjs): the
// same format and rules as the live-demo snapshot, reading files from disk instead of the GitHub
// API. No network and no token.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { assembleSnapshot, MAX_FILE_BYTES } from "./demo-snapshot-rules.mjs";

/** Directory entries one scan may enumerate; the limit of the local-folder source (src/source/local-folder.ts). */
export const MAX_SCAN_ENTRIES = 50_000;
/**
 * Files in one hosted snapshot: as many as a scan may enumerate. The hosted clone is the reader's
 * own repository, not a curated demo, so it may be as large as the local-folder source reads.
 */
export const MAX_HOSTED_FILES = MAX_SCAN_ENTRIES;
/**
 * The serialized snapshot the page downloads and holds in memory as one JSON text. A real
 * repository outgrows the demo's 4 MiB; 64 MiB leaves room for years of messages and text
 * attachments while a browser still parses it comfortably.
 */
export const MAX_HOSTED_BYTES = 64 * 1024 * 1024;
/** Names skipped wherever they appear. */
const SKIPPED = new Set([".git", "node_modules"]);
/** The only directories of a clone that hold snapshot files besides the root files. */
const SCANNED_ROOTS = new Set(["inbox", "topics"]);

/** The path rules of the local-folder source: no backslash and no control character in a name. */
function safeName(name) {
  if (name.includes("\\")) return false;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** The regular files of the clone that can enter the snapshot, with the identity the scan saw. */
async function collectEntries(root) {
  const entries = [];
  const identities = new Map();
  let seen = 0;
  const walk = async (relative) => {
    for (const name of await readdir(join(root, relative))) {
      seen += 1;
      if (seen > MAX_SCAN_ENTRIES) {
        throw new Error("The clone has too many entries to read. Pass the clone folder itself.");
      }
      if (SKIPPED.has(name) || !safeName(name)) continue;
      const path = relative === "" ? name : `${relative}/${name}`;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) {
        if (relative !== "" || SCANNED_ROOTS.has(name)) await walk(path);
      } else if (info.isFile()) {
        // The content is read from disk by path, so no object id is needed.
        entries.push({ path, type: "blob", mode: "100644", sha: "", size: info.size });
        identities.set(path, { dev: info.dev, ino: info.ino });
      }
    }
  };
  await walk("");
  return { entries, identities };
}

/**
 * The first MAX_FILE_BYTES + 1 bytes of a file the scan saw. The file is opened without following
 * a symbolic link and must still be the same regular file: a path that became a link (or sits
 * under a directory that became one) since the scan is not the file the scan saw, so its target is
 * never read. The read stops at the limit, so an endless file cannot hang the build.
 */
async function readScanned(root, entry, identity, beforeRead) {
  await beforeRead?.(entry.path);
  const handle = await open(join(root, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== identity.dev || info.ino !== identity.ino) {
      throw new Error(`The file changed while it was read: ${entry.path}`);
    }
    // One byte beyond the size the open file has: more than that means it grew meanwhile.
    const buffer = Buffer.allocUnsafe(Math.min(info.size, MAX_FILE_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > info.size) throw new Error(`The file changed while it was read: ${entry.path}`);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/**
 * Builds the snapshot of the clone in `directory`. The revision is a hash of the snapshot's files,
 * so it changes only when their content does; `generatedAt` is always the time of this build.
 * `beforeRead(path)` runs just before a scanned file is opened (tests change the disk there).
 */
export async function buildFolderSnapshot(directory, generatedAt, { beforeRead } = {}) {
  const { entries, identities } = await collectEntries(directory);
  const placeholder = "0".repeat(64);
  const { snapshot } = await assembleSnapshot({
    entries,
    readBytes: (entry) => readScanned(directory, entry, identities.get(entry.path), beforeRead),
    revision: placeholder,
    generatedAt,
    limits: { maxFiles: MAX_HOSTED_FILES, maxBytes: MAX_HOSTED_BYTES, subject: "hosted" },
  });
  const revision = createHash("sha256").update(JSON.stringify(snapshot.files)).digest("hex");
  const final = { ...snapshot, revision };
  return { snapshot: final, json: JSON.stringify(final) };
}

/** Writes through a temporary file in the same directory, so a reader never sees a partial file. */
export async function writeFileAtomic(path, content) {
  const temporary = join(dirname(path), `.${basename(path)}.${String(process.pid)}.tmp`);
  try {
    await writeFile(temporary, content);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

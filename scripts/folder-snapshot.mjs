// Builds the hosted-deployment snapshot of a local clone (scripts/create-folder-snapshot.mjs): the
// same format and rules as the live-demo snapshot, reading files from disk instead of the GitHub
// API. No network and no token.

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { assembleSnapshot } from "./demo-snapshot-rules.mjs";

/** Directory entries one scan may enumerate; the limit of the local-folder source (src/source/local-folder.ts). */
export const MAX_SCAN_ENTRIES = 50_000;
/** Names skipped wherever they appear. */
const SKIPPED = new Set([".git", "node_modules"]);
/** The only directories of a clone that hold snapshot files besides the root files. */
const SCANNED_ROOTS = new Set(["inbox", "topics"]);

/** The regular files of the clone that can enter the snapshot, as tree entries. */
async function collectEntries(root) {
  const entries = [];
  let seen = 0;
  const walk = async (relative) => {
    for (const name of await readdir(join(root, relative))) {
      seen += 1;
      if (seen > MAX_SCAN_ENTRIES) {
        throw new Error("The clone has too many entries to read. Pass the clone folder itself.");
      }
      if (SKIPPED.has(name)) continue;
      const path = relative === "" ? name : `${relative}/${name}`;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) {
        if (relative !== "" || SCANNED_ROOTS.has(name)) await walk(path);
      } else if (info.isFile()) {
        // The content is read from disk by path, so no object id is needed.
        entries.push({ path, type: "blob", mode: "100644", sha: "", size: info.size });
      }
    }
  };
  await walk("");
  return entries;
}

/**
 * Builds the snapshot of the clone in `directory`. The revision is a hash of the snapshot's files,
 * so it changes only when their content does; `generatedAt` is always the time of this build.
 */
export async function buildFolderSnapshot(directory, generatedAt) {
  const entries = await collectEntries(directory);
  const readBytes = (entry) => readFile(join(directory, entry.path));
  const placeholder = "0".repeat(64);
  const { snapshot } = await assembleSnapshot({
    entries,
    readBytes,
    revision: placeholder,
    generatedAt,
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

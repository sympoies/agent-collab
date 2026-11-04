// Usage: node scripts/create-folder-snapshot.mjs <clone-dir> <out-file>
// Writes the snapshot of a local clone for a hosted deployment (docs/getting-started.md).

import { resolve } from "node:path";

import { buildFolderSnapshot, writeFileAtomic } from "./folder-snapshot.mjs";

const [directory, outFile] = process.argv.slice(2);
if (directory === undefined || outFile === undefined || process.argv.length > 4) {
  console.error("Usage: create-folder-snapshot.mjs <clone-dir> <out-file>");
  process.exit(2);
}

try {
  const { json } = await buildFolderSnapshot(resolve(directory), new Date().toISOString());
  await writeFileAtomic(resolve(outFile), json);
} catch (error) {
  console.error(error instanceof Error ? error.message : "The snapshot could not be created.");
  process.exit(1);
}

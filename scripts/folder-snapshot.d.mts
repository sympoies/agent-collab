import type { Snapshot } from "./demo-snapshot-rules.mjs";

export const MAX_SCAN_ENTRIES: number;
export function buildFolderSnapshot(
  directory: string,
  generatedAt: string,
): Promise<{ readonly snapshot: Snapshot; readonly json: string }>;
export function writeFileAtomic(path: string, content: string): Promise<void>;

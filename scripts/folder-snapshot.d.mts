import type { Snapshot } from "./demo-snapshot-rules.mjs";

export const MAX_SCAN_ENTRIES: number;
export const MAX_HOSTED_FILES: number;
export const MAX_HOSTED_BYTES: number;
export function buildFolderSnapshot(
  directory: string,
  generatedAt: string,
  options?: { readonly beforeRead?: (path: string) => Promise<void> | void },
): Promise<{ readonly snapshot: Snapshot; readonly json: string }>;
export function writeFileAtomic(path: string, content: string): Promise<void>;

export const MAX_FILE_BYTES: number;
export const MAX_SNAPSHOT_BYTES: number;
export const MAX_SNAPSHOT_FILES: number;

export interface TreeEntry {
  readonly path: string;
  readonly type?: string;
  readonly mode?: string;
  readonly sha?: string;
  readonly size?: number;
}

export interface SnapshotFile {
  readonly path: string;
  readonly text: string;
  readonly omitted?: true;
  readonly size?: number;
}

export interface Snapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly revision: string;
  readonly files: readonly SnapshotFile[];
}

export function isSnapshotPath(path: string): boolean;
export function isSnapshotEntry(entry: TreeEntry | null | undefined): boolean;
export function decodeText(bytes: Uint8Array): string | null;
export function assembleSnapshot(input: {
  readonly entries: readonly TreeEntry[];
  readonly readBytes: (entry: TreeEntry) => Promise<Uint8Array>;
  readonly revision: string;
  readonly generatedAt: string;
}): Promise<{ readonly snapshot: Snapshot; readonly json: string }>;

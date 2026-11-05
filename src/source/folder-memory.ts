// The one local folder this browser remembers across a reload (issue #53): the
// FileSystemDirectoryHandle and its display name, kept in IndexedDB and nothing else (no file
// content, no path). Every operation is guarded: a store that is missing, blocked or full simply
// remembers nothing, and the viewer works from the folder the reader picks again.

import type { RecordStore } from "../credentials/store";
import { LocalFolderSource, type LocalDirectoryHandle } from "./local-folder";
import type { MessageSource } from "./types";

const RECORD = "local-folder";

export type FolderPermission = "granted" | "prompt" | "denied";

/** A folder from an earlier visit. Reading it again may need the reader's permission. */
export interface RememberedFolder {
  readonly name: string;
  /** The last viewer this browser showed was this folder, so a reload should return to it. */
  readonly active: boolean;
  /** The permission as it stands now; never prompts. */
  permission(): Promise<FolderPermission>;
  /** Asks for read permission; the browser needs a user gesture for this. */
  request(): Promise<FolderPermission>;
  open(): { readonly source: MessageSource; readonly name: string };
}

export interface FolderMemory {
  load(): Promise<RememberedFolder | null>;
  /** Remembers this folder in place of any other, as the last viewer shown. */
  save(handle: LocalDirectoryHandle): Promise<void>;
  /**
   * Marks the remembered folder as the last viewer shown or not. `folder` names the folder the
   * caller means; when another tab has since replaced it, nothing changes. Null means whichever.
   */
  setActive(active: boolean, folder: string | null): Promise<void>;
  /** Deletes the record of the folder named `folder`; false when it is not the one stored. */
  forget(folder: string): Promise<boolean>;
}

interface Stored {
  readonly handle: LocalDirectoryHandle;
  readonly name: string;
  readonly active: boolean;
}

function isStored(value: unknown): value is Stored {
  if (typeof value !== "object" || value === null) return false;
  const { handle, name, active } = value as Record<string, unknown>;
  return (
    typeof name === "string" &&
    typeof active === "boolean" &&
    typeof handle === "object" &&
    handle !== null &&
    (handle as { kind?: unknown }).kind === "directory"
  );
}

const asPermission = (state: PermissionState): FolderPermission =>
  state === "granted" || state === "denied" ? state : "prompt";

export function folderMemory(records: RecordStore): FolderMemory {
  // Operations run one after another: a read-modify-write of the active flag must not overlap
  // another, or the older write could land last.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation);
    queue = run.catch(() => undefined);
    return run;
  };
  const read = async (): Promise<Stored | null> => {
    try {
      const value = await records.get(RECORD);
      return isStored(value) ? value : null;
    } catch {
      return null;
    }
  };
  const write = async (value: Stored): Promise<void> => {
    try {
      await records.put(RECORD, value);
    } catch {
      // Nothing is remembered; the folder still opens for this visit.
    }
  };
  const load = async (): Promise<RememberedFolder | null> => {
    const stored = await read();
    if (stored === null) return null;
    const { handle } = stored;
    return {
      name: stored.name,
      active: stored.active,
      permission: async () => {
        try {
          return asPermission((await handle.queryPermission?.({ mode: "read" })) ?? "prompt");
        } catch {
          return "denied";
        }
      },
      request: async () => {
        try {
          return asPermission((await handle.requestPermission?.({ mode: "read" })) ?? "denied");
        } catch {
          return "denied";
        }
      },
      open: () => ({ source: new LocalFolderSource(handle), name: stored.name }),
    };
  };
  return {
    load: () => serial(load),
    save: (handle) => serial(() => write({ handle, name: handle.name, active: true })),
    setActive: (active, folder) =>
      serial(async () => {
        const stored = await read();
        if (stored === null || stored.active === active) return;
        if (folder !== null && stored.name !== folder) return;
        await write({ ...stored, active });
      }),
    forget: (folder) =>
      serial(async () => {
        const stored = await read();
        if (stored?.name !== folder) return false;
        try {
          await records.delete(RECORD);
          return true;
        } catch {
          // Storage is blocked: the record stays, and so does what it holds.
          return false;
        }
      }),
  };
}

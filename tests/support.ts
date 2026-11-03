import { formatDateTime, translate } from "../src/i18n/translate";

// Helpers to build synthetic collaboration repositories for tests.

export const MARKER = "collab-protocol: 1\ninbox-layout: monthly\n";

/** A valid message file for an id of the form YYYY-MM-DDTHHMM-<from>-<topic>-NN. */
export function messageText(
  id: string,
  from: string,
  topic: string,
  fields: Record<string, string> = {},
  body = `Message ${id}.`,
): string {
  const all: Record<string, string> = {
    id,
    from,
    to: from === "alice-agent" ? "bob-agent" : "alice-agent",
    topic,
    type: "info",
    reply_to: "",
    refs: "",
    needs: "none",
    due: "",
    ...fields,
  };
  const head = Object.entries(all)
    .map(([key, value]) => `${key}: ${value}`.trimEnd())
    .join("\n");
  return `---\n${head}\n---\n${body}\n`;
}

/** Repository files for messages from alice-agent on topic "api", keyed by path. */
export function repo(
  paths: readonly string[],
  marker: string | null = MARKER,
): Record<string, string> {
  const files: Record<string, string> = marker === null ? {} : { ".agent-collab": marker };
  for (const path of paths) {
    const id = path.slice(path.lastIndexOf("/") + 1, -".md".length);
    files[path] = messageText(id, "alice-agent", "api");
  }
  return files;
}

/** Monthly path for a minute-of-day sequence: day d, minute m (both 1-based). */
export function monthly(month: string, day: number, minute: number): string {
  const id = `${month}-${String(day).padStart(2, "0")}T09${String(minute).padStart(2, "0")}-alice-agent-api-01`;
  return `inbox/${month}/${id}.md`;
}

export function flat(month: string, day: number, minute: number): string {
  return monthly(month, day, minute).replace(`inbox/${month}/`, "inbox/");
}

/** The first bytes of a PNG file: enough for a header reader, not a decodable image. */
export function pngBytes(width: number, height: number): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    0,
    0,
    0,
    13,
    73,
    72,
    68,
    82,
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
  ]);
}

/** English text and UTC dates, for tests of code that takes a translator. */
export const tEn = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);
export const presenterEn = {
  t: tEn,
  formatDateTime: (date: Date) => formatDateTime("en", date, "UTC"),
};

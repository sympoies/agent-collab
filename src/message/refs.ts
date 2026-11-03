// Classifies the entries of a message's `refs` field (docs/design.md, section 4). Only safe
// repository-relative `topics/` paths become file references and only http(s) URLs without
// credentials become links; everything else stays plain text.

export type FileKind = "markdown" | "text" | "csv" | "image" | "other";

export type Ref =
  | { readonly kind: "message"; readonly id: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly name: string;
      readonly directory: string;
      readonly fileKind: FileKind;
    }
  | { readonly kind: "url"; readonly href: string; readonly host: string }
  | { readonly kind: "text"; readonly text: string };

const MESSAGE_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{4}-[a-z0-9][a-z0-9-]*-\d{2}$/;
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const MARKDOWN = new Set(["md", "markdown"]);
const TEXT = new Set(["txt", "log", "json", "yaml", "yml", "toml"]);
const CSV = new Set(["csv", "tsv"]);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function fileKindOf(name: string): FileKind {
  const ext = extension(name);
  if (MARKDOWN.has(ext)) return "markdown";
  if (TEXT.has(ext)) return "text";
  if (CSV.has(ext)) return "csv";
  if (ext in IMAGE_MIME) return "image";
  return "other";
}

/** MIME type of a raster image; SVG is deliberately not previewed. */
export function imageMime(name: string): string | null {
  return IMAGE_MIME[extension(name)] ?? null;
}

function safeTopicsPath(ref: string): string[] | null {
  // eslint-disable-next-line no-control-regex -- control characters are rejected on purpose
  if (/[\\%\u0000-\u001f\u007f]/.test(ref)) return null;
  const segments = ref.split("/");
  if (segments.length < 2 || segments[0] !== "topics") return null;
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    ? segments
    : null;
}

export function classifyRef(ref: string): Ref {
  if (MESSAGE_ID_RE.test(ref)) return { kind: "message", id: ref };
  const segments = safeTopicsPath(ref);
  if (segments !== null) {
    const name = segments[segments.length - 1] ?? "";
    return {
      kind: "file",
      path: ref,
      name,
      directory: segments.slice(0, -1).join("/"),
      fileKind: fileKindOf(name),
    };
  }
  try {
    const url = new URL(ref);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.hostname !== ""
    ) {
      return { kind: "url", href: url.href, host: url.hostname };
    }
  } catch {
    // Not a URL: shown as text.
  }
  return { kind: "text", text: ref };
}

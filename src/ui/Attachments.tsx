// Attachment chips under a message, file cards with on-demand previews, and the Files view.
// Previews are text or the small Markdown subset only; nothing here creates HTML from file
// content, loads remote images, or follows a link without rel="noopener noreferrer".

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import type { AttachmentReader, FileInfo } from "../loader/attachments";
import { parseCsv } from "../message/csv";
import { classifyRef, imageMime, type FileKind, type Ref } from "../message/refs";
import type { Message } from "../message/types";
import { SourceError } from "../source/types";
import { Markdown } from "./Markdown";

/** Largest text, Markdown or CSV file that is previewed. */
export const TEXT_PREVIEW_MAX_BYTES = 200 * 1024;
/** Largest image that is previewed. */
export const IMAGE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** CSV rows shown in a preview. */
export const CSV_PREVIEW_ROWS = 100;

export interface AttachmentContext {
  readonly reader: AttachmentReader;
  /** Ids of loaded messages, which message refs can jump to. */
  readonly loadedIds: ReadonlySet<string>;
  readonly onJump: (id: string) => void;
}

const BADGES: Readonly<Record<FileKind, string>> = {
  markdown: "MD",
  text: "TXT",
  csv: "CSV",
  image: "IMG",
  other: "FILE",
};

export function formatSize(size: number | null): string {
  if (size === null) return "size unknown";
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function failure(error: unknown): string {
  return error instanceof SourceError && error.kind === "not-found"
    ? "This file is not in the repository at this revision."
    : "Could not load this file.";
}

type Load<T> =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "done"; readonly value: T };

function useLoad<T>(load: () => Promise<T>): Load<T> {
  const [result, setResult] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    let current = true;
    load().then(
      (value) => {
        if (current) setResult({ state: "done", value });
      },
      (error: unknown) => {
        if (current) setResult({ state: "error", message: failure(error) });
      },
    );
    return () => {
      current = false;
    };
    // The card is remounted for another file, so the loader never changes meaning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return result;
}

function OpenLink({ reader, path }: { reader: AttachmentReader; path: string }) {
  const link = reader.webLink(path);
  if (link === null) return null;
  return (
    <a className="open-link" href={link.url} target="_blank" rel="noopener noreferrer">
      Open in {link.label}
    </a>
  );
}

function NoPreview({
  reader,
  path,
  reason,
}: {
  reader: AttachmentReader;
  path: string;
  reason: string;
}) {
  return (
    <p className="note">
      {reason} <OpenLink reader={reader} path={path} />
    </p>
  );
}

function TextPreview({
  reader,
  path,
  kind,
}: {
  reader: AttachmentReader;
  path: string;
  kind: "markdown" | "text" | "csv";
}) {
  const result = useLoad(() => reader.readText(path, TEXT_PREVIEW_MAX_BYTES));
  if (result.state === "loading") return <p className="note">Loading preview…</p>;
  if (result.state === "error") return <p className="note">{result.message}</p>;
  const read = result.value;
  if (read.state === "too-large") {
    return (
      <NoPreview
        reader={reader}
        path={path}
        reason={`Too large to preview (${formatSize(read.size)}).`}
      />
    );
  }
  if (kind === "markdown") return <Markdown text={read.text} />;
  if (kind === "csv") {
    const table = parseCsv(
      read.text,
      path.toLowerCase().endsWith(".tsv") ? "\t" : ",",
      CSV_PREVIEW_ROWS,
    );
    return (
      <div className="csv-preview">
        <table>
          <thead>
            <tr>
              {table.header.map((cell, index) => (
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {table.truncated && (
          <p className="note">
            Showing the first {String(CSV_PREVIEW_ROWS)} of {String(table.totalRows)} rows.
          </p>
        )}
      </div>
    );
  }
  return <pre className="text-preview">{read.text}</pre>;
}

function ImagePreview({
  reader,
  path,
  name,
}: {
  reader: AttachmentReader;
  path: string;
  name: string;
}) {
  const result = useLoad(() => reader.readBytes(path, IMAGE_PREVIEW_MAX_BYTES));
  const mime = imageMime(name);
  const bytes =
    result.state === "done" && result.value.state === "ready" ? result.value.bytes : null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (bytes === null || mime === null) return;
    const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
    // The object URL exists only while the preview is mounted, so it has to be state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [bytes, mime]);
  if (result.state === "loading") return <p className="note">Loading preview…</p>;
  if (result.state === "error") return <p className="note">{result.message}</p>;
  const read = result.value;
  if (read.state === "unsupported") {
    return <NoPreview reader={reader} path={path} reason="This source cannot preview images." />;
  }
  if (read.state === "too-large") {
    return (
      <NoPreview
        reader={reader}
        path={path}
        reason={`Too large to preview (${formatSize(read.size)}).`}
      />
    );
  }
  return url === null ? null : <img className="image-preview" src={url} alt={name} />;
}

function Details({
  file,
  reader,
}: {
  file: Extract<Ref, { kind: "file" }>;
  reader: AttachmentReader;
}) {
  const info = useLoad<FileInfo | null>(() => reader.info(file.path));
  let body: ReactNode;
  if (info.state === "loading") body = <p className="note">Loading…</p>;
  else if (info.state === "error") body = <p className="note">{info.message}</p>;
  else if (info.value === null) {
    body = <p className="note">This file is not in the repository at this revision.</p>;
  } else {
    body = (
      <>
        <p className="file-meta">
          {formatSize(info.value.size)} · <code>{file.path}</code>
        </p>
        {file.fileKind === "other" ? (
          <NoPreview reader={reader} path={file.path} reason="No preview for this file type." />
        ) : file.fileKind === "image" ? (
          imageMime(file.name) === null ? null : (
            <ImagePreview reader={reader} path={file.path} name={file.name} />
          )
        ) : (
          <TextPreview reader={reader} path={file.path} kind={file.fileKind} />
        )}
      </>
    );
  }
  return <div className="file-body">{body}</div>;
}

export function FileCard({
  file,
  reader,
}: {
  file: Extract<Ref, { kind: "file" }>;
  reader: AttachmentReader;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="file-card"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="file-badge">{BADGES[file.fileKind]}</span>
        <span className="file-name">{file.name}</span>
      </summary>
      {open && <Details file={file} reader={reader} />}
    </details>
  );
}

function jumpHandler(id: string, context: AttachmentContext) {
  return (event: MouseEvent) => {
    event.preventDefault();
    context.onJump(id);
  };
}

export function RefList({
  refs,
  context,
}: {
  refs: readonly string[];
  context: AttachmentContext;
}) {
  if (refs.length === 0) return null;
  return (
    <ul className="refs">
      {refs.map((raw, index) => {
        const ref = classifyRef(raw);
        const key = `${String(index)}-${raw}`;
        switch (ref.kind) {
          case "file":
            return (
              <li key={key}>
                <FileCard file={ref} reader={context.reader} />
              </li>
            );
          case "url":
            return (
              <li key={key}>
                <a className="chip" href={ref.href} target="_blank" rel="noopener noreferrer">
                  {ref.host}
                </a>
              </li>
            );
          case "message":
            return (
              <li key={key}>
                {context.loadedIds.has(ref.id) ? (
                  <a
                    className="chip"
                    href={`#msg-${ref.id}`}
                    onClick={jumpHandler(ref.id, context)}
                  >
                    Message {ref.id.slice(0, 10)} {ref.id.slice(11, 13)}:{ref.id.slice(13, 15)}
                  </a>
                ) : (
                  <span className="chip" title="This message is not loaded">
                    Message {ref.id.slice(0, 10)} (not loaded)
                  </span>
                )}
              </li>
            );
          case "text":
            return (
              <li key={key}>
                <span className="chip">{ref.text}</span>
              </li>
            );
        }
      })}
    </ul>
  );
}

interface AttachmentItem {
  readonly ref: Extract<Ref, { kind: "file" | "url" }>;
  readonly message: Message;
}

/** Every file and link referenced in the given messages, once each; the newest reference wins. */
export function collectAttachments(messages: readonly Message[]): AttachmentItem[] {
  const items = new Map<string, AttachmentItem>();
  for (const message of messages) {
    for (const raw of message.refs) {
      const ref = classifyRef(raw);
      if (ref.kind !== "file" && ref.kind !== "url") continue;
      items.set(ref.kind === "file" ? ref.path : ref.href, { ref, message });
    }
  }
  return [...items.values()].sort((a, b) => (a.message.id < b.message.id ? 1 : -1));
}

export function FilesView({
  messages,
  context,
  label,
  hasOlder,
}: {
  messages: readonly Message[];
  context: AttachmentContext;
  label: (name: string) => string;
  /** Older messages are not loaded yet, so their attachments are not listed. */
  hasOlder: boolean;
}) {
  const items = collectAttachments(messages);
  const note = hasOlder && (
    <p className="note">
      Only files and links from the loaded messages are listed. Load older messages to see more.
    </p>
  );
  if (items.length === 0) {
    return (
      <>
        <p className="empty">No files or links in the loaded messages.</p>
        {note}
      </>
    );
  }
  return (
    <>
      {note}
      <FilesList items={items} context={context} label={label} />
    </>
  );
}

function FilesList({
  items,
  context,
  label,
}: {
  items: readonly AttachmentItem[];
  context: AttachmentContext;
  label: (name: string) => string;
}) {
  return (
    <ul className="files">
      {items.map((item) => (
        <li key={item.ref.kind === "file" ? item.ref.path : item.ref.href} className="file-item">
          {item.ref.kind === "file" ? (
            <FileCard file={item.ref} reader={context.reader} />
          ) : (
            <a className="chip" href={item.ref.href} target="_blank" rel="noopener noreferrer">
              {item.ref.host}
            </a>
          )}
          <a
            className="file-from"
            href={`#msg-${item.message.id}`}
            onClick={jumpHandler(item.message.id, context)}
          >
            {label(item.message.from)} · #{item.message.topic} · {item.message.timestamp}
          </a>
        </li>
      ))}
    </ul>
  );
}

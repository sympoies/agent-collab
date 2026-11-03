// Attachment chips under a message, file cards with on-demand details, and the Files view.
// Nothing here creates HTML from file content, loads remote images, or follows a link without
// rel="noopener noreferrer".

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import type { AttachmentReader, FileInfo } from "../loader/attachments";
import { classifyRef, type FileKind, type Ref } from "../message/refs";
import type { Message } from "../message/types";
import { SourceError } from "../source/types";

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
        <p className="note">
          <OpenLink reader={reader} path={file.path} />
        </p>
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
}: {
  messages: readonly Message[];
  context: AttachmentContext;
  label: (name: string) => string;
}) {
  const items = collectAttachments(messages);
  if (items.length === 0) return <p className="empty">No files or links yet.</p>;
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

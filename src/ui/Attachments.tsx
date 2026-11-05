// Attachment chips under a message, file cards with on-demand previews, and the Files view.
// Previews are text or the small Markdown subset only; nothing here creates HTML from file
// content, loads remote images, or follows a link without rel="noopener noreferrer".

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import { useT, type Translate } from "../i18n/LocaleProvider";
import type { AttachmentReader, FileInfo } from "../loader/attachments";
import { parseCsv } from "../message/csv";
import { IMAGE_MAX_PIXELS, imageDimensions } from "../message/image";
import { classifyRef, imageMime, type FileKind, type Ref } from "../message/refs";
import type { Message } from "../message/types";
import { SourceError } from "../source/types";
import { Markdown } from "./Markdown";
import type { People } from "./people";
import {
  EmptyState,
  MetaLine,
  ParticipantIdentity,
  SharedCard,
  TopicChip,
} from "./shared/components";

/** Largest text, Markdown or CSV file that is previewed. */
export const TEXT_PREVIEW_MAX_BYTES = 200 * 1024;
/** Largest image that is previewed. */
export const IMAGE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** CSV rows and columns shown in a preview. */
export const CSV_PREVIEW_ROWS = 100;
export const CSV_PREVIEW_COLUMNS = 50;

export interface AttachmentContext {
  readonly reader: AttachmentReader;
  /** Ids of loaded messages, which message refs can jump to. */
  readonly loadedIds: ReadonlySet<string>;
  readonly onJump: (id: string) => void;
}

/** Format abbreviations read the same in every language; the generic badge is a word. */
const FORMAT_BADGES: Readonly<Record<Exclude<FileKind, "other">, string>> = {
  markdown: "MD",
  text: "TXT",
  csv: "CSV",
  image: "IMG",
};

export function formatSize(size: number | null, t: Translate): string {
  if (size === null) return t("size.unknown");
  if (size < 1024) return t("size.bytes", { value: size });
  if (size < 1024 * 1024) return t("size.kb", { value: (size / 1024).toFixed(1) });
  return t("size.mb", { value: (size / (1024 * 1024)).toFixed(1) });
}

function failure(error: unknown, t: Translate): string {
  if (error instanceof SourceError && error.kind === "not-found") return t("file.notFound");
  if (error instanceof SourceError && error.kind === "rate-limited") return t("file.rateLimited");
  return t("file.failed");
}

type Load<T> =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly error: unknown }
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
        if (current) setResult({ state: "error", error });
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
  const t = useT();
  const link = reader.webLink(path);
  if (link === null) return null;
  return (
    <a className="open-link" href={link.url} target="_blank" rel="noopener noreferrer">
      {t("file.open", { provider: link.label })}
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
  const t = useT();
  const result = useLoad(() => reader.readText(path, TEXT_PREVIEW_MAX_BYTES));
  if (result.state === "loading") return <p className="note">{t("file.loadingPreview")}</p>;
  if (result.state === "error") return <p className="note">{failure(result.error, t)}</p>;
  const read = result.value;
  if (read.state === "unknown-size") {
    return <NoPreview reader={reader} path={path} reason={t("file.unknownSize")} />;
  }
  if (read.state === "too-large") {
    return (
      <NoPreview
        reader={reader}
        path={path}
        reason={t("file.tooLarge", { size: formatSize(read.size, t) })}
      />
    );
  }
  if (kind === "markdown") return <Markdown text={read.text} />;
  if (kind === "csv") {
    const table = parseCsv(
      read.text,
      path.toLowerCase().endsWith(".tsv") ? "\t" : ",",
      CSV_PREVIEW_ROWS,
      CSV_PREVIEW_COLUMNS,
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
            {t("file.csvRows", { shown: CSV_PREVIEW_ROWS, total: table.totalRows })}
          </p>
        )}
        {table.columnsTruncated && (
          <p className="note">
            {t("file.csvColumns", { shown: CSV_PREVIEW_COLUMNS, total: table.totalColumns })}
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
  const t = useT();
  const result = useLoad(() => reader.readBytes(path, IMAGE_PREVIEW_MAX_BYTES));
  const mime = imageMime(name);
  const bytes =
    result.state === "done" && result.value.state === "ready" ? result.value.bytes : null;
  // A small file can decode to a huge bitmap, so the header size is checked before any decoding.
  const size = bytes === null ? null : imageDimensions(bytes);
  const pixels = size === null ? null : size.width * size.height;
  const shown = bytes !== null && pixels !== null && pixels <= IMAGE_MAX_PIXELS ? bytes : null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (shown === null || mime === null) return;
    const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(shown)], { type: mime }));
    // The object URL exists only while the preview is mounted, so it has to be state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [shown, mime]);
  if (result.state === "loading") return <p className="note">{t("file.loadingPreview")}</p>;
  if (result.state === "error") return <p className="note">{failure(result.error, t)}</p>;
  const read = result.value;
  if (read.state === "unsupported") {
    return <NoPreview reader={reader} path={path} reason={t("file.imageUnsupported")} />;
  }
  if (read.state === "unknown-size") {
    return <NoPreview reader={reader} path={path} reason={t("file.unknownSize")} />;
  }
  if (read.state === "too-large") {
    return (
      <NoPreview
        reader={reader}
        path={path}
        reason={t("file.tooLarge", { size: formatSize(read.size, t) })}
      />
    );
  }
  if (size === null) {
    return <NoPreview reader={reader} path={path} reason={t("file.imageUnreadable")} />;
  }
  if (shown === null) {
    return (
      <NoPreview
        reader={reader}
        path={path}
        reason={t("file.tooManyPixels", { width: size.width, height: size.height })}
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
  const t = useT();
  const info = useLoad<FileInfo | null>(() => reader.info(file.path));
  let body: ReactNode;
  if (info.state === "loading") body = <p className="note">{t("file.loading")}</p>;
  else if (info.state === "error") body = <p className="note">{failure(info.error, t)}</p>;
  else if (info.value === null) {
    body = <p className="note">{t("file.notFound")}</p>;
  } else {
    body = (
      <>
        <p className="file-meta">
          {formatSize(info.value.size, t)} · <code>{file.path}</code>
        </p>
        {file.fileKind === "other" ? (
          <NoPreview reader={reader} path={file.path} reason={t("file.noPreview")} />
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
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <details
      className="file-card"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="file-badge">
          {file.fileKind === "other" ? t("file.badgeOther") : FORMAT_BADGES[file.fileKind]}
        </span>
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
  const t = useT();
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
                    {t("file.messageRef", {
                      date: ref.id.slice(0, 10),
                      time: `${ref.id.slice(11, 13)}:${ref.id.slice(13, 15)}`,
                    })}
                  </a>
                ) : (
                  <span className="chip" title={t("file.messageRefMissingTitle")}>
                    {t("file.messageRefMissing", { date: ref.id.slice(0, 10) })}
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

/** Every file and link referenced in the given messages, once each; rows are oldest to newest. */
export function collectAttachments(messages: readonly Message[]): AttachmentItem[] {
  const items = new Map<string, AttachmentItem>();
  for (const message of messages) {
    for (const raw of message.refs) {
      const ref = classifyRef(raw);
      if (ref.kind !== "file" && ref.kind !== "url") continue;
      items.set(ref.kind === "file" ? ref.path : ref.href, { ref, message });
    }
  }
  return [...items.values()].sort((a, b) => a.message.id.localeCompare(b.message.id));
}

export function FilesView({
  messages,
  context,
  people,
  selectedTopic,
  scope,
  onScopeChange,
  hasOlder,
}: {
  messages: readonly Message[];
  context: AttachmentContext;
  people: People;
  selectedTopic: string | null;
  scope: string | null;
  onScopeChange: (topic: string | null) => void;
  /** Older messages are not loaded yet, so their attachments are not listed. */
  hasOlder: boolean;
}) {
  const t = useT();
  const items = collectAttachments(
    scope === null ? messages : messages.filter((message) => message.topic === scope),
  );
  const topicOption = scope ?? selectedTopic;
  const note = hasOlder && <p className="note">{t("files.loadedOnly")}</p>;
  return (
    <div className="files-view">
      <div className="file-scope" role="group" aria-label={t("files.scope")}>
        <button
          type="button"
          className="file-scope-all"
          aria-pressed={scope === null}
          onClick={() => {
            onScopeChange(null);
          }}
        >
          {t("files.allTopics")}
        </button>
        {topicOption !== null && (
          <button
            type="button"
            className="file-scope-topic"
            aria-pressed={scope === topicOption}
            onClick={() => {
              onScopeChange(topicOption);
            }}
          >
            {t("files.topicScope", { topic: topicOption })}
          </button>
        )}
      </div>
      {note}
      {items.length === 0 ? (
        <EmptyState>{t("files.empty")}</EmptyState>
      ) : (
        <FilesList items={items} context={context} people={people} />
      )}
      <div id="latest-message" className="latest-anchor" aria-hidden="true" />
    </div>
  );
}

function FilesList({
  items,
  context,
  people,
}: {
  items: readonly AttachmentItem[];
  context: AttachmentContext;
  people: People;
}) {
  const t = useT();
  return (
    <ul className="files">
      {items.map((item) => {
        const key = item.ref.kind === "file" ? item.ref.path : item.ref.href;
        const excerpt = messageExcerpt(item.message, t, 3);
        return (
          <li key={key} id={`file-${encodeURIComponent(key)}`} className="file-item">
            <SharedCard className="file-row">
              <div className="file-row-heading">
                {item.ref.kind === "file" ? (
                  <FileCard file={item.ref} reader={context.reader} />
                ) : (
                  <a
                    className="chip file-link-name"
                    href={item.ref.href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="file-badge" aria-hidden="true">
                      {t("files.badgeLink")}
                    </span>
                    <span>{item.ref.host}</span>
                  </a>
                )}
                <MetaLine className="file-from">
                  <ParticipantIdentity name={item.message.from} people={people} />
                  {" · "}
                  <TopicChip topic={item.message.topic} />
                  {" · "}
                  <time dateTime={item.message.timestamp.replace(" ", "T")}>
                    {item.message.timestamp}
                  </time>
                </MetaLine>
              </div>
              <p className="file-excerpt">{excerpt}</p>
              <details className="file-full-message">
                <summary>{t("files.showMessage")}</summary>
                <p>{messageExcerpt(item.message, t)}</p>
              </details>
              <a
                className="shared-link file-jump"
                href={`#msg-${item.message.id}`}
                onClick={jumpHandler(item.message.id, context)}
              >
                {t("files.jumpToMessage")}
              </a>
            </SharedCard>
          </li>
        );
      })}
    </ul>
  );
}

function messageExcerpt(message: Message, t: Translate, limit?: number): string {
  if (message.body.state === "locked") return t("chat.encrypted");
  const lines = message.body.lines.filter((line) => line.trim() !== "");
  return limit === undefined ? lines.join("\n") : lines.slice(0, limit).join("\n");
}

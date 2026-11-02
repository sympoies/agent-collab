import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { SetupError, type Loader } from "../loader/loader";
import { Poller } from "../loader/poller";
import { SourceError } from "../source/types";
import { ChatView } from "./ChatView";
import { buildRows, topicSummaries } from "./timeline";

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof SetupError || error instanceof SourceError) return error.message;
  return "Unexpected error while loading messages.";
}

export interface AppProps {
  readonly loader: Loader;
  readonly title: string;
  readonly selfNames: ReadonlySet<string>;
  /** A one-off message from opening the viewer, such as a settings warning. */
  readonly notice: string | null;
  readonly pollIntervalMs?: number;
  readonly onOpenSettings: () => void;
}

export function App({
  loader,
  title,
  selfNames,
  notice,
  pollIntervalMs,
  onOpenSettings,
}: AppProps) {
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot);
  const pollerRef = useRef<Poller | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [readyRetryAt, setReadyRetryAt] = useState<Date | null>(null);

  const showError = (reason: unknown) => {
    setError(reason);
  };

  const run = (operation: () => Promise<unknown>, minimumIntervalMs = 0) => {
    setBusy(true);
    const poller = pollerRef.current;
    const result =
      poller === null
        ? operation().then(() => true)
        : poller.runOperation(operation, minimumIntervalMs);
    result
      .then((ran) => {
        if (ran && poller === null) setError(null);
        if (!ran) {
          setError(
            minimumIntervalMs > 0
              ? "The live demo refreshes every five minutes. Wait for the next check before refreshing again."
              : "A request is already running or waiting for the rate limit reset.",
          );
        }
      })
      .catch((reason: unknown) => {
        showError(reason);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  useEffect(() => {
    const poller = new Poller(() => loader.refresh(), {
      visible: () => document.visibilityState === "visible",
      ...(pollIntervalMs === undefined ? {} : { visibleIntervalMs: pollIntervalMs }),
      rateLimit: () => loader.rateLimit(),
      onError: (reason) => {
        showError(reason);
      },
    });
    pollerRef.current = poller;
    const onVisibility = () => {
      poller.visibilityChanged();
    };
    document.addEventListener("visibilitychange", onVisibility);
    poller.start(() =>
      loader.open().finally(() => {
        setBusy(false);
      }),
    );
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
      pollerRef.current = null;
    };
  }, [loader, pollIntervalMs]);

  const topics = useMemo(
    () => topicSummaries(snapshot.items, snapshot.fresh),
    [snapshot.items, snapshot.fresh],
  );
  const rows = useMemo(
    () =>
      buildRows(snapshot.items, {
        selfNames,
        topic,
        today: localDate(new Date()),
        fresh: snapshot.fresh,
      }),
    [snapshot.items, snapshot.fresh, selfNames, topic],
  );
  const retryAt =
    error instanceof SourceError && error.kind === "rate-limited" ? error.retryAt : null;
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setTimeout(
      () => {
        setReadyRetryAt(retryAt);
      },
      Math.max(0, retryAt.getTime() - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [retryAt]);
  const retryingAfterLimit = retryAt !== null && readyRetryAt?.getTime() !== retryAt.getTime();

  return (
    <div className="app">
      <header className="bar">
        <h1>{title}</h1>
        <button
          type="button"
          disabled={busy || retryingAfterLimit}
          onClick={() => {
            run(() => loader.refresh(), pollIntervalMs ?? 0);
          }}
        >
          Refresh
        </button>
        <button type="button" onClick={onOpenSettings}>
          Settings
        </button>
      </header>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {describe(error)}
        </p>
      )}
      <nav className="topics" aria-label="Topics">
        <button
          type="button"
          aria-pressed={topic === null}
          onClick={() => {
            setTopic(null);
          }}
        >
          All
        </button>
        {topics.map((summary) => (
          <button
            key={summary.topic}
            type="button"
            aria-pressed={topic === summary.topic}
            onClick={() => {
              setTopic(summary.topic);
            }}
          >
            #{summary.topic} <span className="count">{summary.count}</span>
            {summary.fresh > 0 && <span className="fresh">{summary.fresh} new</span>}
          </button>
        ))}
      </nav>
      <main>
        {snapshot.hasOlder && (
          <button
            type="button"
            className="older"
            disabled={busy || retryingAfterLimit}
            onClick={() => {
              run(() => loader.loadOlder());
            }}
          >
            Load older messages
          </button>
        )}
        <ChatView rows={rows} />
      </main>
    </div>
  );
}

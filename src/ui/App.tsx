import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

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
  if (error instanceof SetupError || error instanceof SourceError) return error.message;
  return "Unexpected error while loading messages.";
}

export interface AppProps {
  readonly loader: Loader;
  readonly title: string;
  readonly selfNames: ReadonlySet<string>;
}

export function App({ loader, title, selfNames }: AppProps) {
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot);
  const [topic, setTopic] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = (operation: () => Promise<unknown>) => {
    setBusy(true);
    operation()
      .then(() => {
        setError(null);
      })
      .catch((reason: unknown) => {
        setError(describe(reason));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  useEffect(() => {
    const poller = new Poller(() => loader.refresh(), {
      visible: () => document.visibilityState === "visible",
      rateLimit: () => loader.rateLimit(),
      onError: (reason) => {
        setError(reason === null ? null : describe(reason));
      },
    });
    let active = true;
    loader
      .open()
      .catch((reason: unknown) => {
        setError(describe(reason));
      })
      .finally(() => {
        setBusy(false);
        if (active) poller.start();
      });
    return () => {
      active = false;
      poller.stop();
    };
  }, [loader]);

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

  return (
    <div className="app">
      <header className="bar">
        <h1>{title}</h1>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            run(() => loader.refresh());
          }}
        >
          Refresh
        </button>
      </header>
      {error !== null && (
        <p className="error" role="alert">
          {error}
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
            disabled={busy}
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

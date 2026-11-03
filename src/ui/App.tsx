import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { SetupError, type Loader } from "../loader/loader";
import { Poller } from "../loader/poller";
import {
  colorOrder,
  EMPTY_PREFERENCES,
  readPreferences,
  resetProfile,
  resolveViewer,
  withColor,
  withDisplayName,
  withViewingAs,
  writePreferences,
  type IdentityPreferences,
  type PreferenceStorage,
} from "../identity/preferences";
import { deriveQuestionStates } from "../message/questions";
import { buildReceipts, groupQuestions } from "../message/receipts";
import type { Message } from "../message/types";
import { SourceError } from "../source/types";
import { ChatView } from "./ChatView";
import { buildPeople } from "./people";
import { ProfilePanel } from "./ProfilePanel";
import { QuestionsView } from "./QuestionsView";
import { ThemeToggle } from "./ThemeProvider";
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
  /** Configured own names; the first participant among them is the default "Viewing as". */
  readonly selfNames: ReadonlySet<string>;
  /** Where identity preferences live; null keeps them in memory for this view only. */
  readonly identity: { readonly storage: PreferenceStorage | null; readonly key: string };
  /** A one-off message from opening the viewer, such as a settings warning. */
  readonly notice: string | null;
  readonly pollIntervalMs?: number;
  readonly onCheckLiveNow?: () => Promise<void>;
  readonly onOpenSettings: () => void;
}

export function App({
  loader,
  title,
  selfNames,
  identity,
  notice,
  pollIntervalMs,
  onOpenSettings,
  onCheckLiveNow,
}: AppProps) {
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot);
  const pollerRef = useRef<Poller | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "questions">("chat");
  const pendingJump = useRef<string | null>(null);
  const [mobileConversation, setMobileConversation] = useState(false);
  const conversationHeading = useRef<HTMLHeadingElement | null>(null);
  const lastTopicButton = useRef<HTMLButtonElement | null>(null);
  const announcedMessages = useRef<Set<string>>(new Set());
  const [arrivalAnnouncement, setArrivalAnnouncement] = useState("");
  const [busy, setBusy] = useState(true);
  const [checkingLive, setCheckingLive] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [readyRetryAt, setReadyRetryAt] = useState<Date | null>(null);
  const [preferences, setPreferences] = useState<IdentityPreferences>(() =>
    identity.storage === null ? EMPTY_PREFERENCES : readPreferences(identity.storage, identity.key),
  );
  const [profileOpen, setProfileOpen] = useState(false);

  const updatePreferences = (next: IdentityPreferences) => {
    setPreferences(next);
    writePreferences(identity.storage, identity.key, next);
  };

  const showError = (reason: unknown) => {
    setError(reason);
  };

  const run = (
    operation: () => Promise<unknown>,
    minimumIntervalMs = 0,
    operationKey = "manual",
  ) => {
    setBusy(true);
    const poller = pollerRef.current;
    const result =
      poller === null
        ? operation().then(() => true)
        : operationKey === "refresh"
          ? poller.refreshNow(minimumIntervalMs)
          : poller.runOperation(operation, minimumIntervalMs, operationKey);
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
      onError: showError,
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
  const viewer = useMemo(
    () => resolveViewer(preferences, snapshot.participants, [...selfNames]),
    [preferences, snapshot.participants, selfNames],
  );
  const order = useMemo(
    () =>
      colorOrder(
        snapshot.participants,
        snapshot.formerParticipants,
        snapshot.items.flatMap((item) => (item.kind === "message" ? [item.message.from] : [])),
      ),
    [snapshot.participants, snapshot.formerParticipants, snapshot.items],
  );
  const people = useMemo(() => buildPeople(order, preferences), [order, preferences]);
  const messages = useMemo(
    () => snapshot.items.flatMap((item) => (item.kind === "message" ? [item.message] : [])),
    [snapshot.items],
  );
  const questionStates = useMemo(
    () =>
      deriveQuestionStates(messages, snapshot.participants, snapshot.formerParticipants, {
        rosterKnown: snapshot.rosterKnown,
        incompleteTopics: snapshot.incompleteTopics,
      }),
    [
      messages,
      snapshot.participants,
      snapshot.formerParticipants,
      snapshot.rosterKnown,
      snapshot.incompleteTopics,
    ],
  );
  const receipts = useMemo(
    () =>
      buildReceipts(messages, snapshot.participants, snapshot.formerParticipants, questionStates),
    [messages, snapshot.participants, snapshot.formerParticipants, questionStates],
  );
  const questionGroups = useMemo(
    () => groupQuestions(questionStates, viewer),
    [questionStates, viewer],
  );
  const rows = useMemo(
    () =>
      buildRows(snapshot.items, {
        viewer,
        topic,
        today: localDate(new Date()),
        fresh: snapshot.fresh,
        receipts,
      }),
    [snapshot.items, snapshot.fresh, viewer, topic, receipts],
  );
  const openQuestion = (question: Message) => {
    setView("chat");
    setTopic(question.topic);
    pendingJump.current = question.id;
  };
  useEffect(() => {
    if (pendingJump.current === null || view !== "chat") return;
    document.getElementById(`msg-${pendingJump.current}`)?.scrollIntoView();
    pendingJump.current = null;
  }, [view, rows]);
  useEffect(() => {
    const arrivals = [...snapshot.fresh].filter((path) => !announcedMessages.current.has(path));
    for (const path of snapshot.fresh) announcedMessages.current.add(path);
    if (arrivals.length > 0) {
      const total = announcedMessages.current.size;
      setArrivalAnnouncement(
        `${arrivals.length} new ${arrivals.length === 1 ? "message" : "messages"} arrived. ${total} new ${total === 1 ? "message" : "messages"} since opening this view.`,
      );
    }
  }, [snapshot.fresh]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (mobileConversation) {
        conversationHeading.current?.focus();
      } else {
        lastTopicButton.current?.focus();
      }
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [mobileConversation]);
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
        <div className="bar-actions">
          {onCheckLiveNow === undefined ? (
            <button
              type="button"
              disabled={busy || retryingAfterLimit}
              aria-busy={busy}
              onClick={() => {
                run(() => loader.refresh(), pollIntervalMs ?? 0, "refresh");
              }}
            >
              Refresh
            </button>
          ) : (
            <button
              type="button"
              disabled={checkingLive}
              aria-busy={checkingLive}
              onClick={() => {
                setCheckingLive(true);
                void onCheckLiveNow().finally(() => {
                  setCheckingLive(false);
                });
              }}
            >
              Check live now
            </button>
          )}
          <label className="viewing-as">
            <span>Viewing as</span>
            <select
              value={viewer ?? ""}
              onChange={(event) => {
                updatePreferences(
                  withViewingAs(preferences, event.target.value === "" ? null : event.target.value),
                );
              }}
            >
              <option value="">Observer</option>
              {snapshot.participants.map((name) => (
                <option key={name} value={name}>
                  {people.label(name)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-expanded={profileOpen}
            aria-controls="profile-panel"
            onClick={() => {
              setProfileOpen(!profileOpen);
            }}
          >
            Profile &amp; colors
          </button>
          <ThemeToggle />
          <button type="button" onClick={onOpenSettings}>
            Settings
          </button>
        </div>
      </header>
      {profileOpen && (
        <div id="profile-panel">
          <ProfilePanel
            order={order}
            preferences={preferences}
            people={people}
            onColor={(person, slot) => {
              updatePreferences(withColor(preferences, person, slot));
            }}
            onDisplayName={(person, name) => {
              updatePreferences(withDisplayName(preferences, person, name));
            }}
            onReset={() => {
              updatePreferences(resetProfile(preferences));
            }}
          />
        </div>
      )}
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
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {arrivalAnnouncement}
      </p>
      <div className="workspace" data-mobile-view={mobileConversation ? "conversation" : "topics"}>
        <aside className="topics-pane">
          <h2>Conversations</h2>
          <nav className="topics" aria-label="Topics">
            <button
              type="button"
              aria-pressed={view === "questions"}
              onClick={(event) => {
                setView("questions");
                lastTopicButton.current = event.currentTarget;
                setMobileConversation(window.matchMedia("(max-width: 720px)").matches);
              }}
            >
              <span>Questions</span>
              <span className="count">{questionGroups.open.length} open</span>
            </button>
            <button
              type="button"
              aria-pressed={view === "chat" && topic === null}
              onClick={(event) => {
                setView("chat");
                setTopic(null);
                lastTopicButton.current = event.currentTarget;
                setMobileConversation(window.matchMedia("(max-width: 720px)").matches);
              }}
            >
              All
            </button>
            {topics.map((summary) => (
              <button
                key={summary.topic}
                type="button"
                aria-pressed={view === "chat" && topic === summary.topic}
                onClick={(event) => {
                  setView("chat");
                  setTopic(summary.topic);
                  lastTopicButton.current = event.currentTarget;
                  setMobileConversation(window.matchMedia("(max-width: 720px)").matches);
                }}
              >
                <span>#{summary.topic}</span>
                <span className="count">{summary.count}</span>
                {summary.fresh > 0 && <span className="fresh">{summary.fresh} new</span>}
              </button>
            ))}
          </nav>
        </aside>
        <main className="conversation" aria-labelledby="conversation-heading">
          <button
            type="button"
            className="back-to-topics"
            onClick={() => {
              setMobileConversation(false);
            }}
          >
            Back to conversations
          </button>
          <h2 id="conversation-heading" ref={conversationHeading} tabIndex={-1}>
            {view === "questions"
              ? "Questions"
              : topic === null
                ? "All conversations"
                : `#${topic}`}
          </h2>
          {view === "questions" && (
            <QuestionsView groups={questionGroups} people={people} onOpen={openQuestion} />
          )}
          {view === "chat" && snapshot.hasOlder && (
            <button
              type="button"
              className="older"
              disabled={busy || retryingAfterLimit}
              onClick={() => {
                run(() => loader.loadOlder(), 0, "load-older");
              }}
            >
              Load older messages
            </button>
          )}
          {view === "chat" && <ChatView rows={rows} people={people} />}
        </main>
      </div>
      <a
        className="jump-to-latest"
        data-mobile-view={mobileConversation ? "conversation" : "topics"}
        href="#latest-message"
      >
        Jump to latest
      </a>
    </div>
  );
}

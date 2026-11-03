import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { Loader } from "../loader/loader";
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
import { FilesView, type AttachmentContext } from "./Attachments";
import { ChatView } from "./ChatView";
import type { MessageKey } from "../i18n/catalog";
import { LanguageSwitcher, useLocale } from "../i18n/LocaleProvider";
import type { MessageRef, Params } from "../i18n/translate";
import { buildPeople } from "./people";
import { errorText, say } from "./errorText";
import { relativeTime } from "./relativeTime";
import { ProfilePanel } from "./ProfilePanel";
import { QuestionsView } from "./QuestionsView";
import { ThemeToggle } from "./ThemeProvider";
import { buildRows, topicSummaries } from "./timeline";

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Names a source that is not a repository, so it is always visible which data is shown. */
export interface SourceIndicator {
  readonly label: MessageKey;
  /** Shown as experimental until the source is released. */
  readonly experimental: boolean;
}

/** The current time, refreshed every half minute while `active`, for relative texts. */
function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [active]);
  return now;
}

export interface AppProps {
  readonly loader: Loader;
  /** A repository name, or a catalog message for a fixed title. */
  readonly title: string | { readonly key: MessageKey; readonly params?: Params };
  /** Configured own names; the first participant among them is the default "Viewing as". */
  readonly selfNames: ReadonlySet<string>;
  /** Where identity preferences live; null keeps them in memory for this view only. */
  readonly identity: { readonly storage: PreferenceStorage | null; readonly key: string };
  /** A one-off message from opening the viewer, such as a settings warning. */
  readonly notice: string | MessageRef | null;
  readonly pollIntervalMs?: number;
  readonly onCheckLiveNow?: () => Promise<void>;
  /** The source when it is not a repository; its last-changed time is shown beside it. */
  readonly source?: SourceIndicator;
  /** Chooses another local folder; omitted when the browser cannot open folders. */
  readonly onPickLocalFolder?: () => void;
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
  source,
  onPickLocalFolder,
}: AppProps) {
  const { t, formatDateTime } = useLocale();
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot);
  const now = useNow(source !== undefined && snapshot.lastChanged !== null);
  const pollerRef = useRef<Poller | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "questions" | "files">("chat");
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
          setError({ key: minimumIntervalMs > 0 ? "refresh.demoInterval" : "refresh.busy" });
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
  const showMessage = (id: string) => {
    // The hash scrolls to the message and styles it through :target.
    if (window.location.hash === `#msg-${id}`) window.location.hash = "";
    window.location.hash = `msg-${id}`;
  };
  /** Shows a message in the chat, in `nextTopic` (null shows every topic). */
  const jumpToMessage = (target: Message, nextTopic: string | null) => {
    const sameView = view === "chat" && topic === nextTopic;
    setView("chat");
    setTopic(nextTopic);
    // Without a state change nothing re-renders, so a jump is shown now or dropped, never kept.
    if (!sameView) pendingJump.current = target.id;
    else if (document.getElementById(`msg-${target.id}`) !== null) showMessage(target.id);
  };
  const openQuestion = (question: Message) => {
    jumpToMessage(question, question.topic);
  };
  useEffect(() => {
    const id = pendingJump.current;
    if (id === null || view !== "chat") return;
    // The jump is consumed by the render it caused, whether or not its target is on screen.
    pendingJump.current = null;
    if (document.getElementById(`msg-${id}`) !== null) showMessage(id);
  }, [view, rows]);
  const attachments = useMemo<AttachmentContext>(
    () => ({
      reader: loader.attachments,
      loadedIds: new Set(messages.map((message) => message.id)),
      onJump: (id) => {
        const target = messages.find((message) => message.id === id);
        // A message of another topic needs that topic; "All" shows every message.
        if (target !== undefined) {
          jumpToMessage(target, topic === null || topic === target.topic ? topic : target.topic);
        }
      },
    }),
    // jumpToMessage reads the current view and topic through the closure it is created in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loader, messages, topic, view],
  );
  useEffect(() => {
    const arrivals = [...snapshot.fresh].filter((path) => !announcedMessages.current.has(path));
    for (const path of snapshot.fresh) announcedMessages.current.add(path);
    if (arrivals.length > 0) {
      const total = announcedMessages.current.size;
      setArrivalAnnouncement(t("arrival.announce", { count: arrivals.length, total }));
    }
  }, [snapshot.fresh, t]);
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
        <h1>{typeof title === "string" ? title : t(title.key, title.params)}</h1>
        {source !== undefined && (
          <p className="source-indicator">
            <span className="source-label">
              {t(source.label)}
              {source.experimental && ` · ${t("source.experimental")}`}
            </span>
            {snapshot.lastChanged === null ? (
              <span className="last-changed">{t("source.noChange")}</span>
            ) : (
              <span
                className="last-changed"
                title={t("source.lastChangeTitle", { date: formatDateTime(snapshot.lastChanged) })}
              >
                {t("source.lastChange", { time: relativeTime(snapshot.lastChanged, now, t) })}
              </span>
            )}
          </p>
        )}
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
              {t("bar.refresh")}
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
              {t("bar.checkLive")}
            </button>
          )}
          <label className="viewing-as">
            <span>{t("bar.viewingAs")}</span>
            <select
              value={viewer ?? ""}
              onChange={(event) => {
                updatePreferences(
                  withViewingAs(preferences, event.target.value === "" ? null : event.target.value),
                );
              }}
            >
              <option value="">{t("bar.observer")}</option>
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
            {t("bar.profile")}
          </button>
          {onPickLocalFolder !== undefined && (
            <button type="button" onClick={onPickLocalFolder}>
              {t("bar.localFolder")}
            </button>
          )}
          <LanguageSwitcher />
          <ThemeToggle />
          <button type="button" onClick={onOpenSettings}>
            {t("bar.settings")}
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
          {say(notice, t)}
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {errorText(error, t, formatDateTime)}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {arrivalAnnouncement}
      </p>
      <div className="workspace" data-mobile-view={mobileConversation ? "conversation" : "topics"}>
        <aside className="topics-pane">
          <h2>{t("nav.conversations")}</h2>
          <nav className="topics" aria-label={t("nav.topics")}>
            <button
              type="button"
              aria-pressed={view === "questions"}
              onClick={(event) => {
                pendingJump.current = null;
                setView("questions");
                lastTopicButton.current = event.currentTarget;
                setMobileConversation(window.matchMedia("(max-width: 720px)").matches);
              }}
            >
              <span>{t("nav.questions")}</span>
              <span className="count">
                {t("nav.questionsOpen", { count: questionGroups.open.length })}
              </span>
            </button>
            <button
              type="button"
              aria-pressed={view === "files"}
              onClick={(event) => {
                pendingJump.current = null;
                setView("files");
                lastTopicButton.current = event.currentTarget;
                setMobileConversation(window.matchMedia("(max-width: 720px)").matches);
              }}
            >
              <span>{t("nav.files")}</span>
            </button>
            <button
              type="button"
              aria-pressed={view === "chat" && topic === null}
              onClick={(event) => {
                pendingJump.current = null;
                setView("chat");
                setTopic(null);
                lastTopicButton.current = event.currentTarget;
                setMobileConversation(window.matchMedia("(max-width: 720px)").matches);
              }}
            >
              {t("nav.all")}
            </button>
            {topics.map((summary) => (
              <button
                key={summary.topic}
                type="button"
                aria-pressed={view === "chat" && topic === summary.topic}
                onClick={(event) => {
                  pendingJump.current = null;
                  setView("chat");
                  setTopic(summary.topic);
                  lastTopicButton.current = event.currentTarget;
                  setMobileConversation(window.matchMedia("(max-width: 720px)").matches);
                }}
              >
                <span>#{summary.topic}</span>
                <span className="count">{summary.count}</span>
                {summary.fresh > 0 && (
                  <span className="fresh">{t("nav.fresh", { count: summary.fresh })}</span>
                )}
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
            {t("nav.back")}
          </button>
          <h2 id="conversation-heading" ref={conversationHeading} tabIndex={-1}>
            {view === "questions"
              ? t("heading.questions")
              : view === "files"
                ? topic === null
                  ? t("heading.files")
                  : t("heading.filesIn", { topic })
                : topic === null
                  ? t("heading.all")
                  : `#${topic}`}
          </h2>
          {view === "questions" && (
            <QuestionsView groups={questionGroups} people={people} onOpen={openQuestion} />
          )}
          {view !== "questions" && snapshot.hasOlder && (
            <button
              type="button"
              className="older"
              disabled={busy || retryingAfterLimit}
              onClick={() => {
                run(() => loader.loadOlder(), 0, "load-older");
              }}
            >
              {t("nav.loadOlder")}
            </button>
          )}
          {view === "files" && (
            <FilesView
              messages={
                topic === null ? messages : messages.filter((message) => message.topic === topic)
              }
              context={attachments}
              label={(name) => people.label(name)}
              hasOlder={snapshot.hasOlder}
            />
          )}
          {view === "chat" && <ChatView rows={rows} people={people} attachments={attachments} />}
        </main>
      </div>
      <a
        className="jump-to-latest"
        data-mobile-view={mobileConversation ? "conversation" : "topics"}
        href="#latest-message"
      >
        {t("nav.jumpLatest")}
      </a>
    </div>
  );
}

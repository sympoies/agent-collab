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
import { useLocale } from "../i18n/LocaleProvider";
import type { MessageRef, Params } from "../i18n/translate";
import { buildPeople } from "./people";
import { errorText, say } from "./errorText";
import { IconButton } from "./IconButton";
import { RefreshIcon } from "./icons";
import { localDate, relativeTime } from "./relativeTime";
import { Toolbar } from "./Toolbar";
import { RangeBar } from "./RangeBar";
import { ProfilePanel } from "./ProfilePanel";
import { QuestionsView } from "./QuestionsView";
import { buildRows, topicSummaries } from "./timeline";

/** Names a source that is not a repository, so it is always visible which data is shown. */
export interface SourceIndicator {
  readonly label: MessageKey;
  /** Shown as experimental until the source is released. */
  readonly experimental: boolean;
  /**
   * The data is a copy made at a time, not the source's current state: when it was generated, and
   * when it was last fetched successfully. Both can change without the data changing.
   */
  readonly pointInTime?: {
    readonly generatedAt: () => Date | null;
    readonly checkedAt: () => Date | null;
  };
}

/** A snapshot generated longer ago than this probably stopped being refreshed. */
export const SNAPSHOT_STALE_MS = 10 * 60_000;

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

/**
 * When a served snapshot was generated, with a warning when that is long ago (the script that
 * refreshes it may have stopped) and, while a fetch is failing, when the last one succeeded.
 */
function SnapshotTimes({
  generatedAt,
  checkedAt,
  failing,
  now,
}: {
  readonly generatedAt: Date | null;
  readonly checkedAt: Date | null;
  readonly failing: boolean;
  readonly now: Date;
}) {
  const { t, formatDateTime } = useLocale();
  if (generatedAt === null) return null;
  return (
    <>
      <span
        className="last-changed"
        title={t("source.generatedTitle", { date: formatDateTime(generatedAt) })}
      >
        {t("source.generated", { time: relativeTime(generatedAt, now, t) })}
      </span>
      {now.getTime() - generatedAt.getTime() > SNAPSHOT_STALE_MS && (
        <span className="snapshot-warning">{t("source.stale")}</span>
      )}
      {failing && checkedAt !== null && (
        <span className="snapshot-warning">
          {t("source.lastCheck", { time: relativeTime(checkedAt, now, t) })}
        </span>
      )}
    </>
  );
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
  /** Opens the token section of Settings; offered when the API limit is the problem. */
  readonly onUseToken?: () => void;
  /** The API limit is why a static copy stays on screen (live demo notices). */
  readonly limitHit?: boolean;
  /** The viewer reads with a token: shows the higher-limit banner and a way to remove it. */
  readonly signedIn?: { readonly onRemove: () => void };
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
  onUseToken,
  limitHit = false,
  signedIn,
}: AppProps) {
  const { t, formatDateTime } = useLocale();
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot);
  // The budget the API reported with its latest response; null until a response carried one.
  const reported = signedIn === undefined ? null : loader.rateLimit();
  // Only a plausible budget is shown: whole numbers, and no more left than the limit.
  const budget =
    reported !== null &&
    Number.isSafeInteger(reported.limit) &&
    Number.isSafeInteger(reported.remaining) &&
    reported.limit > 0 &&
    reported.remaining >= 0 &&
    reported.remaining <= reported.limit
      ? reported
      : null;
  const pollerRef = useRef<Poller | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "questions" | "files">("chat");
  const now = useNow(
    (source !== undefined && (source.pointInTime !== undefined || snapshot.lastChanged !== null)) ||
      view === "questions",
  );
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
    // The activated chip may be gone (another topic) or keep focus on itself; either way the
    // reader lands on the message, which the hash has already scrolled to.
    document.getElementById(`msg-${id}`)?.focus({ preventScroll: true });
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
            {source.pointInTime !== undefined ? (
              <SnapshotTimes
                generatedAt={source.pointInTime.generatedAt()}
                checkedAt={source.pointInTime.checkedAt()}
                failing={error !== null}
                now={now}
              />
            ) : snapshot.lastChanged === null ? (
              <span className="last-changed">{t("source.noChange")}</span>
            ) : (
              <span
                className="last-changed"
                title={t("source.lastChangeTitle", { date: formatDateTime(snapshot.lastChanged) })}
              >
                {snapshot.lastChangedBy === null
                  ? t("source.lastChange", { time: relativeTime(snapshot.lastChanged, now, t) })
                  : t("source.lastChangeBy", {
                      time: relativeTime(snapshot.lastChanged, now, t),
                      name: people.label(snapshot.lastChangedBy),
                    })}
              </span>
            )}
          </p>
        )}
        <Toolbar
          primary={
            onCheckLiveNow === undefined ? (
              <IconButton
                label={t("bar.refresh")}
                disabled={busy || retryingAfterLimit}
                aria-busy={busy}
                onClick={() => {
                  run(() => loader.refresh(), pollIntervalMs ?? 0, "refresh");
                }}
              >
                <RefreshIcon />
              </IconButton>
            ) : (
              <IconButton
                label={t("bar.checkLive")}
                disabled={checkingLive}
                aria-busy={checkingLive}
                onClick={() => {
                  setCheckingLive(true);
                  void onCheckLiveNow().finally(() => {
                    setCheckingLive(false);
                  });
                }}
              >
                <RefreshIcon />
              </IconButton>
            )
          }
          viewingAs={
            <label className="viewing-as">
              <span>{t("bar.viewingAs")}</span>
              <select
                value={viewer ?? ""}
                onChange={(event) => {
                  updatePreferences(
                    withViewingAs(
                      preferences,
                      event.target.value === "" ? null : event.target.value,
                    ),
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
          }
          profileOpen={profileOpen}
          onToggleProfile={() => {
            setProfileOpen(!profileOpen);
          }}
          onPickLocalFolder={onPickLocalFolder}
          onOpenSettings={onOpenSettings}
        />
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
      {onUseToken !== undefined &&
        signedIn === undefined &&
        (limitHit || (error instanceof SourceError && error.kind === "rate-limited")) && (
          <p className="notice-action">
            <button type="button" onClick={onUseToken}>
              {t("notice.useToken")}
            </button>
          </p>
        )}
      {signedIn !== undefined && (
        <p className="notice signed-in">
          {t("signedIn.banner")}
          {budget !== null && (
            <> {t("signedIn.remaining", { remaining: budget.remaining, limit: budget.limit })}</>
          )}{" "}
          <button type="button" onClick={signedIn.onRemove}>
            {t("signedIn.remove")}
          </button>
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
                <span className="topic-name">#{summary.topic}</span>
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
            <QuestionsView
              groups={questionGroups}
              people={people}
              now={now}
              onOpen={openQuestion}
            />
          )}
          {view !== "questions" && (
            <RangeBar
              messages={messages}
              jumpedTo={snapshot.jumpedTo}
              disabled={busy || retryingAfterLimit}
              onJump={(date) => {
                run(() => loader.jumpTo(date), 0, "jump");
              }}
            />
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
          {view === "chat" && (
            <ChatView
              rows={rows}
              people={people}
              attachments={attachments}
              earlier={{
                // Ids start with their timestamp, so a parent that sorts before the oldest loaded
                // message is older than the loaded range.
                beforeId: snapshot.hasOlder ? (messages[0]?.id ?? null) : null,
                disabled: busy || retryingAfterLimit,
                onLoad: () => {
                  run(() => loader.loadOlder(), 0, "load-older");
                },
              }}
            />
          )}
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

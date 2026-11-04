import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { Loader } from "../loader/loader";
import { Poller } from "../loader/poller";
import { TopicSession, type TopicDigest } from "../loader/topic-session";
import { sortTopicSummaries } from "../loader/topic-activity";
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
import type { TopicSummary } from "../message/topic-layout";
import { SourceError, type MessageSource } from "../source/types";
import { FilesView, type AttachmentContext } from "./Attachments";
import { ChatView } from "./ChatView";
import type { MessageKey } from "../i18n/catalog";
import { useLocale } from "../i18n/LocaleProvider";
import type { MessageRef, Params } from "../i18n/translate";
import { buildPeople } from "./people";
import { errorText, say } from "./errorText";
import { IconButton } from "./IconButton";
import { RefreshIcon } from "./icons";
import { relativeTime } from "./relativeTime";
import { Toolbar } from "./Toolbar";
import { RangeBar } from "./RangeBar";
import { ProfilePanel } from "./ProfilePanel";
import { QuestionsView } from "./QuestionsView";
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

function TopicListButton({
  topic,
  selected,
  onVisible,
  onSelect,
}: {
  readonly topic: TopicSummary;
  readonly selected: boolean;
  readonly onVisible: (topic: TopicSummary) => Promise<boolean>;
  readonly onSelect: (topic: TopicSummary, button: HTMLButtonElement) => void;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const element = button.current;
    if (element === null || !topic.folder) return;
    if (typeof IntersectionObserver === "undefined") {
      void onVisible(topic);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void onVisible(topic).then((loaded) => {
            if (loaded) observer.disconnect();
          });
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [onVisible, topic]);
  return (
    <button
      ref={button}
      type="button"
      aria-pressed={selected}
      onClick={(event) => {
        onSelect(topic, event.currentTarget);
      }}
    >
      <span className="topic-name">{topic.title ?? topic.name}</span>
    </button>
  );
}

export interface AppProps {
  readonly loader: Loader;
  /** The source used to inspect topic-layout repositories before messages are loaded. */
  readonly topicSource?: MessageSource;
  /** A topic session already opened by the root when a local folder was selected. */
  readonly initialTopicSession?: TopicSession;
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
  topicSource,
  initialTopicSession,
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
  const [topicSession] = useState<TopicSession | null>(
    () => initialTopicSession ?? (topicSource === undefined ? null : new TopicSession(topicSource)),
  );
  const [topicList, setTopicList] = useState<readonly TopicSummary[] | null>(
    initialTopicSession?.topics() ?? null,
  );
  const [topicLayout, setTopicLayout] = useState(initialTopicSession?.inboxLayout === "topic");
  const [discoveryReady, setDiscoveryReady] = useState(
    topicSession === null || initialTopicSession !== undefined,
  );
  const [topic, setTopic] = useState<string | null>(null);
  const [allTopicsSelected, setAllTopicsSelected] = useState(false);
  const [activeTopicLoader, setActiveTopicLoader] = useState<Loader | null>(null);
  const [topicLoaders, setTopicLoaders] = useState<Map<string, Loader>>(() => new Map());
  const [topicLoaderRevision, setTopicLoaderRevision] = useState(0);
  const [digests, setDigests] = useState<Map<string, TopicDigest>>(() => new Map());
  const digestRequests = useRef(new Set<string>());
  const viewLoader =
    activeTopicLoader ?? (topicLayout ? (topicLoaders.values().next().value ?? loader) : loader);
  const viewSnapshot = useSyncExternalStore(viewLoader.subscribe, viewLoader.getSnapshot);
  const loadedTopicState = useMemo(
    () => ({
      revision: topicLoaderRevision,
      snapshots: [...topicLoaders.values()].map((topicLoader) => topicLoader.getSnapshot()),
    }),
    [topicLoaderRevision, topicLoaders],
  );
  const snapshot = useMemo(() => {
    if (!topicLayout || activeTopicLoader !== null) return viewSnapshot;
    const loaded = loadedTopicState.snapshots;
    const items = loaded.flatMap((item) => item.items);
    const uniqueItems = [
      ...new Map(
        items.map((item) => [item.kind === "message" ? item.message.path : item.path, item]),
      ).values(),
    ].sort((a, b) => {
      const key = (item: (typeof items)[number]) =>
        item.kind === "message" ? item.message.id : item.path;
      return key(a).localeCompare(key(b));
    });
    return {
      items: uniqueItems,
      hasOlder: false,
      jumpedTo: null,
      fresh: new Set(loaded.flatMap((item) => [...item.fresh])),
      participants: [...new Set(loaded.flatMap((item) => item.participants))].sort(),
      formerParticipants: [...new Set(loaded.flatMap((item) => item.formerParticipants))].sort(),
      rosterKnown: loaded.some((item) => item.rosterKnown),
      incompleteTopics: loaded.flatMap((item) => item.incompleteTopics ?? []),
      lastChanged: loaded.find((item) => item.lastChanged !== null)?.lastChanged ?? null,
    };
  }, [activeTopicLoader, loadedTopicState, topicLayout, viewSnapshot]);
  const now = useNow(source !== undefined && snapshot.lastChanged !== null);
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
  const [view, setView] = useState<"chat" | "questions" | "files">("chat");
  const pendingJump = useRef<string | null>(null);
  const [mobileConversation, setMobileConversation] = useState(false);
  const conversationHeading = useRef<HTMLHeadingElement | null>(null);
  const lastTopicButton = useRef<HTMLButtonElement | null>(null);
  const announcedMessages = useRef<Set<string>>(new Set());
  const [arrivalAnnouncement, setArrivalAnnouncement] = useState("");
  const [busy, setBusy] = useState(initialTopicSession?.inboxLayout === "topic" ? false : true);
  const [checkingLive, setCheckingLive] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [readyRetryAt, setReadyRetryAt] = useState<Date | null>(null);
  const [preferences, setPreferences] = useState<IdentityPreferences>(() =>
    identity.storage === null ? EMPTY_PREFERENCES : readPreferences(identity.storage, identity.key),
  );
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    if (topicSession === null || initialTopicSession !== undefined) return;
    let current = true;
    void topicSession.open().then(
      async () => {
        if (topicSession.inboxLayout !== "topic") {
          const head = topicSession.currentHead;
          if (head !== null) await loader.openWithHead(head);
        }
        if (!current) return;
        setTopicList(topicSession.topics());
        setTopicLayout(topicSession.inboxLayout === "topic");
        setDiscoveryReady(true);
        setBusy(false);
      },
      (reason: unknown) => {
        if (!current) return;
        setError(reason);
        setBusy(false);
      },
    );
    return () => {
      current = false;
    };
  }, [initialTopicSession, loader, topicSession]);

  useEffect(() => {
    if (!topicLayout || activeTopicLoader !== null) return;
    const unsubscribe = [...topicLoaders.values()].map((topicLoader) =>
      topicLoader.subscribe(() => {
        setTopicLoaderRevision((revision) => revision + 1);
      }),
    );
    return () => {
      for (const remove of unsubscribe) remove();
    };
  }, [activeTopicLoader, topicLayout, topicLoaders]);

  const retryDiscovery = useCallback(() => {
    if (topicSession === null || discoveryReady) return;
    setBusy(true);
    setError(null);
    void topicSession
      .open()
      .then(async () => {
        if (topicSession.inboxLayout !== "topic") {
          const head = topicSession.currentHead;
          if (head !== null) await loader.openWithHead(head);
        }
        setTopicList(topicSession.topics());
        setTopicLayout(topicSession.inboxLayout === "topic");
        setDiscoveryReady(true);
      })
      .catch((reason: unknown) => {
        setError(reason);
      })
      .finally(() => {
        setBusy(false);
      });
  }, [discoveryReady, loader, topicSession]);

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
    if (!discoveryReady || (topicLayout && activeTopicLoader === null)) return;
    const currentLoader = activeTopicLoader ?? loader;
    const poller = new Poller(
      () =>
        topicLayout && topicSession !== null ? topicSession.refresh() : currentLoader.refresh(),
      {
        visible: () => document.visibilityState === "visible",
        ...(pollIntervalMs === undefined ? {} : { visibleIntervalMs: pollIntervalMs }),
        rateLimit: () => loader.rateLimit(),
        onError: showError,
      },
    );
    pollerRef.current = poller;
    const onVisibility = () => {
      poller.visibilityChanged();
    };
    document.addEventListener("visibilitychange", onVisibility);
    poller.start(() => {
      const head = topicLayout ? (topicSession?.currentHead ?? null) : null;
      const opening = head === null ? currentLoader.open() : currentLoader.openWithHead(head);
      return opening.finally(() => {
        setBusy(false);
        if (topicLayout) setTopicLoaderRevision((revision) => revision + 1);
      });
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
      pollerRef.current = null;
    };
  }, [activeTopicLoader, discoveryReady, loader, pollIntervalMs, topicLayout, topicSession]);

  const topics = useMemo(
    () => topicSummaries(snapshot.items, snapshot.fresh),
    [snapshot.items, snapshot.fresh],
  );
  const topicListTopics = useMemo(
    () => (topicLayout && topicList !== null ? sortTopicSummaries(topicList, digests) : []),
    [digests, topicLayout, topicList],
  );
  const selectedTopicSummary = topicListTopics.find((summary) => summary.name === topic);
  const requestTopicDigest = useCallback(
    async (summary: TopicSummary): Promise<boolean> => {
      if (topicSession === null || !summary.folder || digestRequests.current.has(summary.name)) {
        return false;
      }
      digestRequests.current.add(summary.name);
      try {
        const digest = await topicSession.digest(summary.name);
        setDigests((previous) => new Map(previous).set(summary.name, digest));
        setError(null);
        return true;
      } catch (reason) {
        digestRequests.current.delete(summary.name);
        setError(reason);
        return false;
      }
    },
    [topicSession],
  );
  const openTopic = (summary: TopicSummary, button: HTMLButtonElement) => {
    if (topicSession === null) return;
    let next = topicLoaders.get(summary.name);
    if (next === undefined) {
      const created = topicSession.loader(summary.name);
      next = created;
      setTopicLoaders((previous) => new Map(previous).set(summary.name, created));
    }
    pendingJump.current = null;
    setView("chat");
    setTopic(summary.name);
    setAllTopicsSelected(false);
    setActiveTopicLoader(next);
    setBusy(true);
    lastTopicButton.current = button;
    setMobileConversation(window.matchMedia("(max-width: 720px)").matches);
  };
  const openAll = (button: HTMLButtonElement) => {
    pendingJump.current = null;
    setView("chat");
    setTopic(null);
    setAllTopicsSelected(true);
    setActiveTopicLoader(null);
    lastTopicButton.current = button;
    setMobileConversation(window.matchMedia("(max-width: 720px)").matches);
  };
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
    if (topicLayout && topicSession !== null && nextTopic !== null) {
      let next = topicLoaders.get(nextTopic);
      if (next === undefined) {
        const created = topicSession.loader(nextTopic);
        next = created;
        setTopicLoaders((previous) => new Map(previous).set(nextTopic, created));
      }
      setActiveTopicLoader(next);
    }
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
      reader: viewLoader.attachments,
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
    [messages, topic, view, viewLoader],
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
        <Toolbar
          primary={
            topicSession !== null && !discoveryReady ? (
              <IconButton
                label={t("bar.refresh")}
                disabled={busy || retryingAfterLimit}
                aria-busy={busy}
                onClick={retryDiscovery}
              >
                <RefreshIcon />
              </IconButton>
            ) : topicLayout && activeTopicLoader === null ? null : onCheckLiveNow === undefined ? (
              <IconButton
                label={t("bar.refresh")}
                disabled={busy || retryingAfterLimit}
                aria-busy={busy}
                onClick={() => {
                  run(() => viewLoader.refresh(), pollIntervalMs ?? 0, "refresh");
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
      {topicSession !== null && !discoveryReady ? (
        <main className="topic-discovery">
          <h2>{t("heading.topicsLoading")}</h2>
          <p>{t(error === null ? "topic.loadingPrompt" : "topic.retryPrompt")}</p>
        </main>
      ) : (
        <div
          className="workspace"
          data-mobile-view={mobileConversation ? "conversation" : "topics"}
        >
          <aside className="topics-pane">
            <h2>{t(topicLayout ? "nav.topics" : "nav.conversations")}</h2>
            <nav className="topics" aria-label={t("nav.topics")}>
              {topicLayout ? (
                <>
                  <button
                    type="button"
                    aria-pressed={view === "chat" && allTopicsSelected}
                    onClick={(event) => {
                      openAll(event.currentTarget);
                    }}
                  >
                    {t("nav.all")}
                  </button>
                  {topicListTopics
                    .filter((summary) => summary.status !== "closed")
                    .map((summary) => (
                      <TopicListButton
                        key={summary.name}
                        topic={summary}
                        selected={view === "chat" && topic === summary.name}
                        onVisible={requestTopicDigest}
                        onSelect={openTopic}
                      />
                    ))}
                  {topicListTopics.some((summary) => summary.status === "closed") && (
                    <details className="closed-topics">
                      <summary>
                        {t("topic.closedCount", {
                          count: topicListTopics.filter((summary) => summary.status === "closed")
                            .length,
                        })}
                      </summary>
                      {topicListTopics
                        .filter((summary) => summary.status === "closed")
                        .map((summary) => (
                          <TopicListButton
                            key={summary.name}
                            topic={summary}
                            selected={view === "chat" && topic === summary.name}
                            onVisible={requestTopicDigest}
                            onSelect={openTopic}
                          />
                        ))}
                    </details>
                  )}
                </>
              ) : (
                <>
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
                </>
              )}
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
            <h2
              id="conversation-heading"
              className={topicLayout && topic !== null ? "topic-heading" : undefined}
              ref={conversationHeading}
              tabIndex={-1}
            >
              {view === "questions"
                ? t("heading.questions")
                : view === "files"
                  ? topic === null
                    ? t("heading.files")
                    : t("heading.filesIn", { topic })
                  : topic === null
                    ? topicLayout && !allTopicsSelected
                      ? t("heading.selectTopic")
                      : t("heading.all")
                    : topicLayout
                      ? (selectedTopicSummary?.title ?? topic)
                      : `#${topic}`}
            </h2>
            {topicLayout && !allTopicsSelected && topic === null && (
              <p className="topic-prompt">{t("topic.selectPrompt")}</p>
            )}
            {view === "questions" && (
              <QuestionsView groups={questionGroups} people={people} onOpen={openQuestion} />
            )}
            {view !== "questions" && (!topicLayout || activeTopicLoader !== null) && (
              <RangeBar
                messages={messages}
                jumpedTo={snapshot.jumpedTo}
                disabled={busy || retryingAfterLimit}
                onJump={(date) => {
                  run(() => viewLoader.jumpTo(date), 0, "jump");
                }}
              />
            )}
            {view !== "questions" &&
              snapshot.hasOlder &&
              (!topicLayout || activeTopicLoader !== null) && (
                <button
                  type="button"
                  className="older"
                  disabled={busy || retryingAfterLimit}
                  onClick={() => {
                    run(() => viewLoader.loadOlder(), 0, "load-older");
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
                    run(() => viewLoader.loadOlder(), 0, "load-older");
                  },
                }}
              />
            )}
          </main>
        </div>
      )}
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

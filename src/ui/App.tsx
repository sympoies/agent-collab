import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Loader } from "../loader/loader";
import { Poller } from "../loader/poller";
import { sameTopics, sortTopicSummaries } from "../loader/topic-activity";
import { TopicSession } from "../loader/topic-session";
import { readViewState, writeViewState, type ViewName } from "../identity/view-state";
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
import { localDate, relativeTime } from "./relativeTime";
import { Toolbar, useNarrow } from "./Toolbar";
import { RangeBar } from "./RangeBar";
import { ProfilePanel } from "./ProfilePanel";
import { QuestionsView } from "./QuestionsView";
import { useFollowLatest, type DateLanding } from "./follow-latest";
import { TopicList } from "./TopicList";
import { useMergedSnapshot } from "./merged-snapshot";
import { mapLimit } from "../source/map-limit";
import { useTopicDigests } from "./useTopicDigests";
import { buildRows, topicSummaries } from "./timeline";

/** Topics the All view reads at once, like the topic activity reads. */
const ALL_CONCURRENCY = 4;

/** Names a source that is not a repository, so it is always visible which data is shown. */
export interface SourceIndicator {
  readonly label: MessageKey;
  /** The action that returns to a source that cannot be refreshed live. */
  readonly actionLabel?: MessageKey;
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
  /**
   * The source the loader reads. With it the viewer checks the repository layout first: a
   * repository in the topic layout opens as a topic list and reads a topic's messages on demand.
   */
  readonly topicSource?: MessageSource;
  /** The topic session a caller already opened on `topicSource`, so the layout is not read twice. */
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
  const [discovered, setDiscovered] = useState(initialTopicSession !== undefined);
  const discoveryReady = topicSession === null || discovered;
  const [topicList, setTopicList] = useState<readonly TopicSummary[]>(
    () => initialTopicSession?.topics() ?? [],
  );
  const [topicLayout, setTopicLayout] = useState(initialTopicSession?.inboxLayout === "topic");
  // Counts reads of the topic list, so a failed activity read is tried again after each one.
  const [topicSyncs, setTopicSyncs] = useState(0);
  // The view and topic the reader had before a reload; a topic that is gone is dropped.
  const [saved] = useState(() => {
    const state = readViewState(identity.storage, identity.key);
    const known = initialTopicSession?.topics().some((summary) => summary.name === state.topic);
    return known === true ? state : { ...state, topic: null };
  });
  const [openedTopics, setOpenedTopics] = useState<readonly string[]>(
    saved.topic === null ? [] : [saved.topic],
  );
  const [closedOpen, setClosedOpen] = useState(false);
  // What is loaded: the topics opened so far in the topic layout, the one loader otherwise.
  // The topics the All view has read so far. Only a topic that was read is registered with the
  // session, so a refresh never opens (and reads a first page of) a topic nobody asked for.
  const [allRead, setAllRead] = useState<ReadonlySet<string>>(() => new Set());
  const allNames = useMemo(
    () => topicList.filter((summary) => summary.status !== "closed").map((summary) => summary.name),
    [topicList],
  );
  const loadedTopics = useMemo(
    () => [...new Set([...openedTopics, ...allRead])],
    [allRead, openedTopics],
  );
  const openedLoaders = useMemo(
    () =>
      topicLayout && topicSession !== null
        ? loadedTopics.map((name) => topicSession.loader(name))
        : [loader],
    [loadedTopics, loader, topicLayout, topicSession],
  );
  const snapshot = useMergedSnapshot(openedLoaders);
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
  const [topic, setTopic] = useState<string | null>(saved.topic);
  const [view, setView] = useState<ViewName>(saved.view);
  useEffect(() => {
    writeViewState(identity.storage, identity.key, { view, topic });
  }, [identity.key, identity.storage, topic, view]);
  const now = useNow(
    (source !== undefined && (source.pointInTime !== undefined || snapshot.lastChanged !== null)) ||
      view === "questions",
  );
  const pendingJump = useRef<string | null>(null);
  const [mobileConversation, setMobileConversation] = useState(false);
  // State, not a ref: the pane renders once the topics are known, and landing waits for it.
  const [messagePane, setMessagePane] = useState<HTMLElement | null>(null);
  const [dateLanding, setDateLanding] = useState<DateLanding | null>(null);
  const conversationHeading = useRef<HTMLHeadingElement | null>(null);
  const lastTopicButton = useRef<HTMLButtonElement | null>(null);
  const announcedMessages = useRef<Set<string>>(new Set());
  const [arrivalAnnouncement, setArrivalAnnouncement] = useState("");
  const [busy, setBusy] = useState(true);
  // The loader whose older pages and date jumps the chat offers: the open topic's, or the
  // repository's own; null while All shows the topics loaded so far.
  const selectedLoader = useMemo(
    () =>
      !topicLayout
        ? loader
        : topic !== null && topicSession !== null && openedTopics.includes(topic)
          ? topicSession.loader(topic)
          : null,
    [loader, openedTopics, topic, topicLayout, topicSession],
  );
  const pagedLoaders = useMemo(
    () => (selectedLoader === null ? [] : [selectedLoader]),
    [selectedLoader],
  );
  const paging = useMergedSnapshot(pagedLoaders);
  const [checkingLive, setCheckingLive] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // A restored topic still has to read its first page.
  useEffect(() => {
    if (saved.topic === null || topicSession === null) return;
    topicSession
      .loader(saved.topic)
      .openWithHead(topicSession.currentHead)
      .catch((reason: unknown) => {
        setError(reason);
      });
  }, [saved.topic, topicSession]);
  const [readyRetryAt, setReadyRetryAt] = useState<Date | null>(null);
  const [preferences, setPreferences] = useState<IdentityPreferences>(() =>
    identity.storage === null ? EMPTY_PREFERENCES : readPreferences(identity.storage, identity.key),
  );
  const [profileOpen, setProfileOpen] = useState(false);

  // The panel is an overlay: Escape or a click outside closes it and focus goes back to the
  // control that opens it (the icon button, or the More button on a phone).
  const restoreProfileFocus = useRef(false);
  const closeProfile = () => {
    restoreProfileFocus.current = true;
    setProfileOpen(false);
  };
  // Focus goes back after the panel is gone: while a phone sheet is open the rest of the page is
  // inert, which cannot take focus.
  useEffect(() => {
    if (profileOpen || !restoreProfileFocus.current) return;
    restoreProfileFocus.current = false;
    (
      document.querySelector<HTMLElement>(".bar-actions [aria-controls=profile-panel]") ??
      document.querySelector<HTMLElement>(".bar-actions [aria-haspopup=menu]")
    )?.focus();
  }, [profileOpen]);
  const narrow = useNarrow();
  const sheetOpen = profileOpen && narrow;
  // The phone sheet covers the whole screen: nothing behind it may take focus.
  useEffect(() => {
    if (!sheetOpen) return;
    const behind = [
      ...document.querySelectorAll<HTMLElement>(
        ".app-shell > :not(header), .app-shell > header > :not(#profile-panel)",
      ),
    ];
    for (const element of behind) element.inert = true;
    return () => {
      for (const element of behind) element.inert = false;
    };
  }, [sheetOpen]);
  useEffect(() => {
    if (!profileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeProfile();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("#profile-panel") === null &&
        target.closest(".bar-actions") === null
      ) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [profileOpen]);

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

  /**
   * Reads the repository layout and, in the topic layout, the topic list again. The first call
   * after a failed discovery starts over, so the poller's retries finish the discovery too.
   */
  const syncTopics = useCallback(async (): Promise<unknown> => {
    if (topicSession === null) return undefined;
    try {
      return await topicSession.refresh();
    } finally {
      // A loader that failed to refresh still leaves the list as the latest listing read it.
      if (topicSession.currentHead !== null) {
        const latest = topicSession.topics();
        setTopicList((known) => (sameTopics(known, latest) ? known : latest));
        setTopicSyncs((count) => count + 1);
        setTopicLayout(topicSession.inboxLayout === "topic");
        setDiscovered(true);
      }
    }
  }, [topicSession]);
  // A repository that is not in the topic layout is polled through its own loader.
  const syncing = topicSession !== null && (!discovered || topicLayout);

  useEffect(() => {
    const poller = new Poller(() => (syncing ? syncTopics() : loader.refresh()), {
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
    const head = topicSession?.currentHead ?? null;
    const first = () =>
      !syncing
        ? head === null
          ? loader.open()
          : loader.openWithHead(head)
        : discovered
          ? Promise.resolve()
          : syncTopics();
    poller.start(() =>
      first().finally(() => {
        setBusy(false);
      }),
    );
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.stop();
      pollerRef.current = null;
    };
  }, [discovered, loader, pollIntervalMs, syncTopics, syncing, topicSession]);

  const topics = useMemo(
    () => topicSummaries(snapshot.items, snapshot.fresh),
    [snapshot.items, snapshot.fresh],
  );
  const digests = useTopicDigests(
    topicLayout ? topicSession : null,
    topicList,
    topic,
    closedOpen,
    topicSyncs,
    setError,
  );
  const sortedTopics = useMemo(() => sortTopicSummaries(topicList, digests), [digests, topicList]);
  // The list does not reorder under the pointer or the keyboard focus: a new order waits until the
  // reader leaves it.
  const [listHeld, setListHeld] = useState({ pointer: false, focus: false });
  const [listedTopics, setListedTopics] = useState(sortedTopics);
  if (!listHeld.pointer && !listHeld.focus && listedTopics !== sortedTopics) {
    setListedTopics(sortedTopics);
  }
  // All is every topic that is not closed, read in the background (at most four at a time) while
  // it is shown, plus any closed topic the viewer opened. Until every one is read the view says
  // how many are, so a partial list is never taken for the whole. On a phone it waits for the
  // conversation pane, so the topic list stays free of reads.
  const showingAll = view === "chat" && topic === null && topicLayout;
  const allSession = showingAll && (!narrow || mobileConversation) ? topicSession : null;
  const allKey = allNames.join("\n");
  const allReadNow = useRef(allRead);
  useEffect(() => {
    if (allSession === null) return;
    const stopped = new AbortController();
    // A call, so the check after an await is not narrowed by the one before it.
    const isStopped = () => stopped.signal.aborted;
    const names = allKey === "" ? [] : allKey.split("\n");
    void mapLimit(
      names.filter((name) => !allReadNow.current.has(name)),
      ALL_CONCURRENCY,
      async (name) => {
        if (isStopped()) return;
        try {
          await allSession.loader(name).openWithHead(allSession.currentHead);
          allReadNow.current = new Set(allReadNow.current).add(name);
          setAllRead(allReadNow.current);
        } catch (reason) {
          // Left unread: the count keeps saying so, and the next sync of the topic list tries again.
          if (!isStopped()) setError(reason);
        }
      },
    );
    return () => {
      stopped.abort();
    };
  }, [allKey, allSession, topicSyncs]);
  const allTotal = allNames.length;
  const allDone = allNames.filter((name) => allRead.has(name)).length;
  const allLoading = showingAll && allDone < allTotal;
  const closedHidden = topicList.some(
    (summary) => summary.status === "closed" && !loadedTopics.includes(summary.name),
  );
  const openTopic = (summary: TopicSummary, button: HTMLButtonElement) => {
    if (topicSession === null) return;
    setOpenedTopics((previous) =>
      previous.includes(summary.name) ? previous : [...previous, summary.name],
    );
    setBusy(true);
    topicSession
      .loader(summary.name)
      .openWithHead(topicSession.currentHead)
      .catch(showError)
      .finally(() => {
        setBusy(false);
      });
    pendingJump.current = null;
    setView("chat");
    setTopic(summary.name);
    lastTopicButton.current = button;
    setMobileConversation(window.matchMedia("(max-width: 720px)").matches);
  };
  const order = useMemo(
    () =>
      colorOrder(
        snapshot.participants,
        snapshot.formerParticipants,
        snapshot.items.flatMap((item) => (item.kind === "message" ? [item.message.from] : [])),
      ),
    [snapshot.participants, snapshot.formerParticipants, snapshot.items],
  );
  const viewingAsParticipants = snapshot.rosterKnown ? snapshot.participants : order;
  const viewer = useMemo(
    () => resolveViewer(preferences, viewingAsParticipants, [...selfNames]),
    [preferences, selfNames, viewingAsParticipants],
  );
  const people = useMemo(() => buildPeople(order, preferences), [order, preferences]);
  const messages = useMemo(
    () => snapshot.items.flatMap((item) => (item.kind === "message" ? [item.message] : [])),
    [snapshot.items],
  );
  // The loaded messages of the loader that pages the chat.
  const pagedMessages = useMemo(
    () => paging.items.flatMap((item) => (item.kind === "message" ? [item.message] : [])),
    [paging.items],
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
  // Before the effect below consumes a pending jump: a message opened by link keeps its place.
  useFollowLatest(
    messagePane,
    view === "chat" ? (topic ?? "") : null,
    mobileConversation,
    rows,
    pendingJump,
    dateLanding,
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
      reader: (selectedLoader ?? openedLoaders[0] ?? loader).attachments,
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
    [loader, messages, openedLoaders, selectedLoader, topic, view],
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
        conversationHeading.current?.focus({ preventScroll: true });
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
    <div className="app app-shell">
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
                  run(
                    () => (syncing ? syncTopics() : loader.refresh()),
                    pollIntervalMs ?? 0,
                    "refresh",
                  );
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
                {viewingAsParticipants.map((name) => (
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
          {...(source?.actionLabel === undefined
            ? {}
            : { localFolderActionLabel: source.actionLabel })}
          onOpenSettings={onOpenSettings}
        />
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
              onClose={closeProfile}
            />
          </div>
        )}
      </header>
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
      {!discoveryReady ? (
        <main className="topic-discovery">
          <h2>{t("heading.opening")}</h2>
          <p>{t(error === null ? "opening.loading" : "opening.retry")}</p>
        </main>
      ) : (
        <div
          className="workspace"
          data-mobile-view={mobileConversation ? "conversation" : "topics"}
        >
          <aside className="topics-pane">
            <h2>{t(topicLayout ? "nav.topics" : "nav.conversations")}</h2>
            <nav
              className="topics"
              aria-label={t("nav.topics")}
              onPointerEnter={() => {
                setListHeld((held) => ({ ...held, pointer: true }));
              }}
              onPointerLeave={() => {
                setListHeld((held) => ({ ...held, pointer: false }));
              }}
              onFocus={() => {
                setListHeld((held) => ({ ...held, focus: true }));
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setListHeld((held) => ({ ...held, focus: false }));
                }
              }}
            >
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
              {topicLayout ? (
                <TopicList
                  topics={listedTopics}
                  selected={topic}
                  pressed={view === "chat" ? topic : null}
                  closedOpen={closedOpen}
                  onClosedOpenChange={setClosedOpen}
                  onSelect={openTopic}
                />
              ) : (
                topics.map((summary) => (
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
                ))
              )}
            </nav>
          </aside>
          <main
            className="conversation"
            aria-labelledby="conversation-heading"
            tabIndex={0}
            ref={setMessagePane}
          >
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
                    ? t("heading.all")
                    : `#${topic}`}
            </h2>
            {topicLayout && loadedTopics.length === 0 && (
              <p className="topic-prompt">{t("topic.selectPrompt")}</p>
            )}
            {showingAll && (allLoading || closedHidden) && (
              <p className="all-status" role="status">
                {allLoading
                  ? t("all.loading", { done: allDone, total: allTotal })
                  : t("all.closedNote")}
              </p>
            )}
            {view === "questions" && (
              <QuestionsView
                groups={questionGroups}
                people={people}
                now={now}
                onOpen={openQuestion}
              />
            )}
            {view !== "questions" && selectedLoader !== null && (
              <RangeBar
                messages={pagedMessages}
                jumpedTo={paging.jumpedTo}
                disabled={busy || retryingAfterLimit}
                onJump={(date) => {
                  run(
                    async () => {
                      await selectedLoader.jumpTo(date);
                      setDateLanding({ date });
                    },
                    0,
                    "jump",
                  );
                }}
              />
            )}
            {view !== "questions" && selectedLoader !== null && paging.hasOlder && (
              <button
                type="button"
                className="older"
                disabled={busy || retryingAfterLimit}
                onClick={() => {
                  run(() => selectedLoader.loadOlder(), 0, "load-older");
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
                hasOlder={paging.hasOlder}
              />
            )}
            {view === "chat" && (
              <ChatView
                rows={rows}
                loading={allLoading}
                people={people}
                attachments={attachments}
                earlier={{
                  // Ids start with their timestamp, so a parent that sorts before the oldest loaded
                  // message is older than the loaded range.
                  beforeId: paging.hasOlder ? (pagedMessages[0]?.id ?? null) : null,
                  disabled: busy || retryingAfterLimit,
                  onLoad: () => {
                    if (selectedLoader !== null) {
                      run(() => selectedLoader.loadOlder(), 0, "load-older");
                    }
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

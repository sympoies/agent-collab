// Switches between the settings screen and the viewer. Secrets go straight from
// the credential store into the message source; they are never kept in React state.

import { useEffect, useRef, useState } from "react";

import type { Secret } from "../credentials/secret";
import { Loader, SetupError } from "../loader/loader";
import { TopicSession } from "../loader/topic-session";
import {
  DEFAULT_DRAFT,
  draftFromSettings,
  loadSettings,
  type CredentialStorage,
  type DraftErrors,
  type SettingsDraft,
  type ViewerSettings,
} from "../settings/model";
import {
  apply,
  removeCredentials,
  restore,
  storedEndpoints,
  type OpenSettings,
  type SettingsDeps,
} from "../settings/session";
import {
  checkLive,
  LIVE_DEMO_POLL_INTERVAL_MS,
  LiveCheckGate,
  openLiveDemo,
  type StaticDemoView,
} from "../settings/live-demo";
import { DEMO_REPOSITORY } from "../settings/live-demo";
import { demoFiles } from "../demo/fixtures";
import type { MessageRef } from "../i18n/translate";
import { SourceError, type MessageSource } from "../source/types";
import { LanguageSwitcher, useLocale } from "../i18n/LocaleProvider";
import { say } from "./errorText";
import { App, type AppProps, type SourceIndicator } from "./App";
import { SettingsView } from "./SettingsView";
import { ThemeToggle } from "./ThemeProvider";

/** A folder the user picked: the source that reads it and its display name. */
export interface LocalFolderOpen {
  readonly source: MessageSource;
  readonly name: string;
  /** The source cannot observe changes after selection. */
  readonly snapshot?: boolean;
}

export type LocalFolderSelection =
  | { readonly kind: "files"; readonly files: readonly File[] | FileList }
  | { readonly kind: "drop"; readonly dataTransfer: DataTransfer };

export interface RootProps extends SettingsDeps {
  readonly createSource: (settings: ViewerSettings, token: Secret) => MessageSource;
  readonly createDemoSource: () => MessageSource;
  /** The live demo source; the token, when there is one, is only sent to the API host. */
  readonly createLiveDemoSource: (token: Secret | null) => MessageSource;
  /** Opens the browser's folder picker; null when the browser has none. Needs a user gesture. */
  readonly openLocalFolder: (() => Promise<LocalFolderOpen>) | null;
  /** Creates a read-only source from a directory input or dropped folder. */
  readonly openLocalFileList?: (selection: LocalFolderSelection) => Promise<LocalFolderOpen>;
  /** Reads the snapshot this deployment serves next to the app; null when it serves none. */
  readonly createHostedSource?: (() => MessageSource) | null;
}

interface ViewerScreen {
  readonly kind: "viewer";
  /** Distinct per opened viewer, so reopening the same repository starts fresh. */
  readonly id: number;
  readonly loader: Loader;
  readonly title: AppProps["title"];
  readonly selfNames: ReadonlySet<string>;
  readonly identity: AppProps["identity"];
  readonly notice: string | MessageRef | null;
  readonly pollIntervalMs: number | undefined;
  /** The static demo copy on screen, or null for every other viewer, live demo included. */
  readonly liveDemo: StaticDemoView | null;
  /** Names the source when it is not a repository, such as a local folder. */
  readonly source: SourceIndicator | null;
  /** The public demo, in any copy; its rate limit notices offer a token. */
  readonly demo: boolean;
  /** The API limit is why a static demo copy stays on screen. */
  readonly limitHit: boolean;
  /** The viewer reads with a token. */
  readonly signedIn: boolean;
  /** The source to check for the topic layout first; null for the demos, which are flat. */
  readonly topicSource: MessageSource | null;
  /** A topic session already opened on `topicSource`, when the root checked the layout. */
  readonly initialTopicSession: TopicSession | null;
}

/**
 * Reads a source's layout before showing it: a repository in the topic layout opens as a topic
 * list and loads no message yet, any other loads its newest page at once, so the error of an
 * unreadable repository reaches the caller before a viewer is shown.
 */
async function openRepository(
  source: MessageSource,
): Promise<{ readonly loader: Loader; readonly session: TopicSession }> {
  const loader = new Loader(source);
  const session = new TopicSession(source);
  await session.open();
  if (session.inboxLayout !== "topic") await loader.openWithHead(session.currentHead);
  return { loader, session };
}

/** The demos neither read nor write browser storage, so identity choices last for the view. */
const MEMORY_ONLY = { storage: null, key: "demo" } as const;

/**
 * The hosted snapshot is a real repository's data, so the reader's choices are kept for this
 * deployment (origin and base path, which tell two deployments on one origin apart), like those
 * of a GitHub repository; the demos keep nothing.
 */
const hostedIdentityKey = () => `hosted:${window.location.origin}${import.meta.env.BASE_URL}`;

type Screen =
  | { readonly kind: "welcome" }
  | {
      readonly kind: "settings";
      readonly draft: SettingsDraft;
      readonly storedEndpoints: Readonly<Record<CredentialStorage, string | null>>;
      /** The viewer to return to on cancel. */
      readonly back: ViewerScreen | null;
      /** Scroll to the token section and focus its field. */
      readonly focusToken: boolean;
    }
  | ViewerScreen;

export function Root(props: RootProps) {
  const { t, formatDateTime } = useLocale();
  const {
    createSource,
    createDemoSource,
    createLiveDemoSource,
    openLocalFolder,
    openLocalFileList,
  } = props;
  const createHostedSource = props.createHostedSource ?? null;
  const [screen, setScreen] = useState<Screen>({ kind: "welcome" });
  const viewers = useRef(0);
  const navigation = useRef(0);
  // Page-session state of the public demo: API requests are spaced across every
  // open and check, and a live copy once read replaces the static copies for good.
  const [liveGate] = useState(() => new LiveCheckGate());
  const liveLoader = useRef<Loader | null>(null);
  /** Whether the cached live copy was read with a token. */
  const liveSignedIn = useRef(false);
  /** Why a folder could not be opened, shown on the welcome screen. */
  const [localMessage, setLocalMessage] = useState<MessageRef | null>(null);
  const localFileInput = useRef<HTMLInputElement>(null);
  const pendingFilePick = useRef<{
    readonly operation: number;
    readonly current: ViewerScreen | null;
  } | null>(null);

  const viewer = (
    loader: Loader,
    title: AppProps["title"],
    selfNames: readonly string[],
    identity: ViewerScreen["identity"],
    notice: string | MessageRef | null = null,
    pollIntervalMs?: number,
    liveDemo: StaticDemoView | null = null,
    source: SourceIndicator | null = null,
    extras: Partial<
      Pick<ViewerScreen, "demo" | "limitHit" | "signedIn" | "topicSource" | "initialTopicSession">
    > = {},
  ): ViewerScreen => {
    viewers.current += 1;
    return {
      kind: "viewer",
      id: viewers.current,
      loader,
      title,
      selfNames: new Set(selfNames),
      identity,
      notice,
      pollIntervalMs,
      liveDemo,
      source,
      demo: extras.demo ?? false,
      limitHit: extras.limitHit ?? false,
      signedIn: extras.signedIn ?? false,
      topicSource: extras.topicSource ?? null,
      initialTopicSession: extras.initialTopicSession ?? null,
    };
  };

  const open = ({ settings, token }: OpenSettings, notice: string | MessageRef | null = null) => {
    const source = createSource(settings, token);
    return viewer(
      new Loader(source),
      settings.repository,
      settings.selfNames,
      {
        storage: props.storage,
        key: `${settings.platform}:${settings.endpoint}/${settings.repository}`,
      },
      notice,
      undefined,
      null,
      null,
      { signedIn: true, topicSource: source },
    );
  };

  /**
   * The token the user saved this page session for the public API, kept in memory only so the demo
   * can use it for its live copy. Reloading forgets it; nothing here reads a credential store, so
   * a slow or locked store never delays the demo.
   */
  const sessionToken = useRef<Secret | null>(null);
  /** Counts changes of the demo token, so a request that started under another token is dropped. */
  const tokenGeneration = useRef(0);
  /**
   * Sets the demo token (null for none). Whenever it changes, including to null, the cached live
   * copy goes with it: that copy was read with the old token and must not outlive it.
   */
  const changeToken = (next: Secret | null) => {
    const current = sessionToken.current;
    if (
      current === next ||
      (current !== null && next !== null && current.reveal() === next.reveal())
    ) {
      return;
    }
    sessionToken.current = next;
    tokenGeneration.current += 1;
    liveLoader.current = null;
    liveSignedIn.current = false;
    if (next !== null) liveGate.reset();
  };
  const rememberToken = ({ settings, token }: OpenSettings) => {
    changeToken(
      settings.credentialStorage === "memory" && settings.endpoint === DEFAULT_DRAFT.endpoint
        ? token
        : null,
    );
  };
  const demoToken = () => sessionToken.current;

  const showSettings = async (
    back: ViewerScreen | null,
    options: { readonly focusToken?: boolean; readonly demo?: boolean } = {},
  ) => {
    const operation = ++navigation.current;
    const settings = loadSettings(props.storage);
    let draft = settings === null ? DEFAULT_DRAFT : draftFromSettings(settings);
    // From the demo, the token is for the demo repository unless a repository is already set up.
    if (options.demo === true && draft.repository === "") {
      draft = { ...draft, repository: DEMO_REPOSITORY };
    }
    const stored = await storedEndpoints(props);
    if (operation !== navigation.current) return;
    setScreen({
      kind: "settings",
      draft,
      storedEndpoints: stored,
      back,
      focusToken: options.focusToken === true,
    });
  };

  const openSavedRepository = async () => {
    const operation = ++navigation.current;
    try {
      const opened = await restore(props);
      if (operation !== navigation.current) return;
      if (opened === null) await showSettings(null);
      else {
        rememberToken(opened);
        setScreen(open(opened));
      }
    } catch {
      if (operation !== navigation.current) return;
      await showSettings(null);
    }
  };

  const liveViewer = (
    loader: Loader,
    notice: string | MessageRef,
    signedIn = false,
  ): ViewerScreen =>
    viewer(
      loader,
      { key: "app.liveDemoTitle" },
      [],
      MEMORY_ONLY,
      notice,
      LIVE_DEMO_POLL_INTERVAL_MS,
      null,
      null,
      { demo: true, signedIn },
    );

  const showLiveDemo = async (): Promise<void> => {
    const operation = ++navigation.current;
    if (liveLoader.current !== null) {
      setScreen(liveViewer(liveLoader.current, { key: "live.showingLive" }, liveSignedIn.current));
      return;
    }
    const token = demoToken();
    const generation = tokenGeneration.current;
    const result = await openLiveDemo(() => createLiveDemoSource(token), demoFiles, liveGate, {
      t,
      formatDateTime,
    });
    // The token may have been removed or replaced while this ran; its result is then dropped, and
    // so is the block it recorded: that limit belonged to another identity's budget.
    if (generation !== tokenGeneration.current) {
      liveGate.reset();
      return;
    }
    if (result.view.kind === "live") {
      liveLoader.current = result.loader;
      liveSignedIn.current = token !== null;
    }
    if (operation !== navigation.current) return;
    setScreen(
      result.view.kind === "live"
        ? liveViewer(result.loader, result.banner, token !== null)
        : viewer(
            result.loader,
            { key: "app.liveDemoTitle" },
            [],
            MEMORY_ONLY,
            result.banner,
            LIVE_DEMO_POLL_INTERVAL_MS,
            result.view,
            null,
            { demo: true, limitHit: result.rateLimited },
          ),
    );
  };

  const checkLiveNow = async (current: ViewerScreen): Promise<void> => {
    if (current.liveDemo === null) return;
    const token = demoToken();
    const generation = tokenGeneration.current;
    const result = await checkLive(() => createLiveDemoSource(token), current.liveDemo, liveGate, {
      t,
      formatDateTime,
    });
    if (generation !== tokenGeneration.current) {
      liveGate.reset();
      return;
    }
    if (result.loader !== null) {
      liveLoader.current = result.loader;
      liveSignedIn.current = token !== null;
    }
    const next =
      result.loader === null
        ? { ...current, notice: result.notice, limitHit: result.rateLimited }
        : liveViewer(result.loader, result.notice, token !== null);
    // Leave a viewer the user has since navigated away from alone.
    setScreen((previous) =>
      previous.kind === "viewer" && previous.id === current.id ? next : previous,
    );
  };

  const forgetToken = () => {
    changeToken(null);
  };

  /** Forgets the token everywhere and returns to the welcome screen, anonymous again. */
  const removeToken = async (current: ViewerScreen): Promise<void> => {
    const operation = ++navigation.current;
    try {
      await removeCredentials(props);
    } catch {
      setScreen((previous) =>
        previous.kind === "viewer" && previous.id === current.id
          ? { ...previous, notice: { key: "settings.removeFailed" } }
          : previous,
      );
      return;
    }
    forgetToken();
    if (operation === navigation.current) setScreen({ kind: "welcome" });
  };

  /** Opens a local folder or snapshot, keeping asynchronous selections scoped to this navigation. */
  const openLocalSource = async (
    openSource: () => Promise<LocalFolderOpen>,
    current: ViewerScreen | null,
    operation: number,
  ): Promise<void> => {
    const refuse = (message: MessageRef) => {
      if (operation !== navigation.current) return;
      if (current === null) setLocalMessage(message);
      else {
        setScreen((previous) =>
          previous.kind === "viewer" && previous.id === current.id
            ? { ...previous, notice: message }
            : previous,
        );
      }
    };
    let opened: LocalFolderOpen;
    try {
      opened = await openSource();
    } catch (error) {
      // Cancelling and a refused sensitive folder both reject; the reason is never shown. A page
      // the browser does not trust with folders is told apart from a cancelled picker.
      refuse(
        error instanceof DOMException && error.name === "SecurityError"
          ? { key: "local.blocked" }
          : error instanceof SourceError && error.kind === "too-large"
            ? { key: "local.tooLarge" }
            : { key: "local.noFolder" },
      );
      return;
    }
    let loader: Loader;
    let session: TopicSession;
    try {
      ({ loader, session } = await openRepository(opened.source));
    } catch (error) {
      refuse(
        error instanceof SetupError
          ? { key: "local.notClone" }
          : error instanceof SourceError && error.kind === "too-large"
            ? { key: "local.tooLarge" }
            : { key: "local.unreadable" },
      );
      return;
    }
    if (operation !== navigation.current) return;
    setLocalMessage(null);
    setScreen(
      viewer(
        loader,
        { key: "app.localTitle", params: { name: opened.name } },
        [],
        { storage: props.storage, key: `local:${opened.name}` },
        opened.snapshot === true
          ? {
              key:
                opened.source.participantsKnown === false
                  ? "local.snapshotNoticeRosterUnknown"
                  : "local.snapshotNotice",
            }
          : null,
        undefined,
        null,
        {
          label: "bar.localFolder",
          ...(opened.snapshot === true ? { actionLabel: "bar.localFolderSnapshot" as const } : {}),
          experimental: true,
        },
        { topicSource: opened.source, initialTopicSession: session },
      ),
    );
  };

  /**
   * Picks and opens a local folder. The picker is called first, straight from the click, because
   * it needs the user gesture. Nothing is saved: the handle lives only in this view.
   */
  const chooseLocalFolder = async (current: ViewerScreen | null): Promise<void> => {
    if (openLocalFolder === null) return;
    const operation = ++navigation.current;
    await openLocalSource(openLocalFolder, current, operation);
  };

  const chooseLocalFiles = async (
    selection: LocalFolderSelection,
    current: ViewerScreen | null,
    operation = ++navigation.current,
  ): Promise<void> => {
    if (openLocalFileList === undefined) return;
    if (selection.kind === "files" && selection.files.length === 0) return;
    await openLocalSource(() => openLocalFileList(selection), current, operation);
  };

  const beginFilePick = (current: ViewerScreen | null): void => {
    if (openLocalFileList === undefined) return;
    const operation = ++navigation.current;
    pendingFilePick.current = { operation, current };
    localFileInput.current?.click();
  };

  const acceptFilePick = (files: FileList): void => {
    const pending = pendingFilePick.current;
    pendingFilePick.current = null;
    if (pending === null || pending.operation !== navigation.current) return;
    void chooseLocalFiles({ kind: "files", files }, pending.current, pending.operation);
  };

  const acceptDroppedFolder = (dataTransfer: DataTransfer): void => {
    if (openLocalFileList === undefined) return;
    const operation = ++navigation.current;
    void chooseLocalFiles({ kind: "drop", dataTransfer }, null, operation);
  };

  const folderInput = (
    <input
      ref={localFileInput}
      type="file"
      multiple
      hidden
      aria-label={t("welcome.openLocalFiles")}
      {...({ webkitdirectory: "" } as Record<string, string>)}
      onChange={(event) => {
        const files = event.currentTarget.files;
        if (files !== null) acceptFilePick(files);
        event.currentTarget.value = "";
      }}
    />
  );

  /** Opens the snapshot this deployment serves; the welcome screen shows why when it fails. */
  const showHosted = async (): Promise<void> => {
    if (createHostedSource === null) return;
    const operation = ++navigation.current;
    const source = createHostedSource();
    let loader: Loader;
    let session: TopicSession;
    try {
      ({ loader, session } = await openRepository(source));
    } catch {
      if (operation === navigation.current) setLocalMessage({ key: "hosted.unreadable" });
      return;
    }
    if (operation !== navigation.current) return;
    setLocalMessage(null);
    setScreen(
      viewer(
        loader,
        { key: "app.hostedTitle" },
        [],
        { storage: props.storage, key: hostedIdentityKey() },
        null,
        undefined,
        null,
        {
          label: "bar.hostedSnapshot",
          experimental: false,
          pointInTime: {
            generatedAt: () => source.snapshotTime?.() ?? null,
            checkedAt: () => source.checkedAt?.() ?? null,
          },
        },
        { topicSource: source, initialTopicSession: session },
      ),
    );
  };

  // A deployment that serves a snapshot goes straight to it; the welcome screen stays reachable
  // through its button when the snapshot cannot be read.
  useEffect(() => {
    void showHosted();
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (draft: SettingsDraft): Promise<DraftErrors | null> => {
    const operation = ++navigation.current;
    const result = await apply(props, draft);
    if (operation !== navigation.current) return null;
    if (!result.ok) return result.errors;
    rememberToken(result.open);
    setScreen(open(result.open, result.warning === null ? null : { key: result.warning }));
    return null;
  };

  switch (screen.kind) {
    case "welcome":
      return (
        <>
          {folderInput}
          <div
            className="app settings"
            onDragOver={(event) => {
              if (openLocalFileList !== undefined) event.preventDefault();
            }}
            onDrop={(event) => {
              if (openLocalFileList === undefined) return;
              event.preventDefault();
              acceptDroppedFolder(event.dataTransfer);
            }}
          >
            <header className="bar settings-bar">
              <h1>{t("app.title")}</h1>
              <div className="bar-actions">
                <LanguageSwitcher />
                <ThemeToggle />
              </div>
            </header>
            {createHostedSource !== null && (
              <>
                <h2>{t("welcome.hostedHeading")}</h2>
                <button
                  type="button"
                  onClick={() => {
                    void showHosted();
                  }}
                >
                  {t("welcome.openHosted")}
                </button>
              </>
            )}
            <h2>{t("welcome.demoHeading")}</h2>
            <button
              type="button"
              onClick={() => {
                void showLiveDemo();
              }}
            >
              {t("welcome.openLiveDemo")}
            </button>
            <p className="note">{t("welcome.limits")}</p>
            {openLocalFolder !== null && (
              <button
                type="button"
                onClick={() => {
                  void chooseLocalFolder(null);
                }}
              >
                {t("welcome.openLocal")}
              </button>
            )}
            {openLocalFolder === null && openLocalFileList !== undefined && (
              <button
                type="button"
                onClick={() => {
                  beginFilePick(null);
                }}
              >
                {t("welcome.openLocalFiles")}
              </button>
            )}
            {openLocalFolder === null && (
              <p className="local-unsupported note">{t("welcome.localUnsupported")}</p>
            )}
            {openLocalFileList !== undefined && <p className="note">{t("welcome.localDrop")}</p>}
            {localMessage !== null && (
              <p className="error" role="alert">
                {say(localMessage, t)}
              </p>
            )}
            <h2>{t("welcome.connectHeading")}</h2>
            <button type="button" onClick={() => void openSavedRepository()}>
              {t("welcome.openSaved")}
            </button>
            <button
              type="button"
              onClick={() => {
                void showSettings(null);
              }}
            >
              {t("welcome.openAnother")}
            </button>
          </div>
        </>
      );
    case "settings": {
      const back = screen.back;
      return (
        <div className="app">
          <header className="bar settings-bar">
            <h1>{t("app.settingsTitle")}</h1>
            <div className="bar-actions">
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
          </header>
          <SettingsView
            initial={screen.draft}
            storedEndpoints={screen.storedEndpoints}
            onSave={save}
            onRemoveCredentials={async () => {
              const operation = ++navigation.current;
              await removeCredentials(props);
              forgetToken();
              if (operation !== navigation.current) return;
              await showSettings(null);
            }}
            onCancel={
              back === null
                ? null
                : () => {
                    navigation.current += 1;
                    setScreen(
                      back.liveDemo !== null && liveLoader.current !== null
                        ? liveViewer(
                            liveLoader.current,
                            { key: "live.showingLive" },
                            liveSignedIn.current,
                          )
                        : back,
                    );
                  }
            }
            onOpenDemo={() => {
              setScreen(
                viewer(
                  new Loader(createDemoSource()),
                  { key: "app.demoTitle" },
                  ["alice-agent"],
                  MEMORY_ONLY,
                ),
              );
            }}
            onOpenLiveDemo={() => {
              void showLiveDemo();
            }}
            focusToken={screen.focusToken}
          />
        </div>
      );
    }
    case "viewer":
      return (
        <>
          {folderInput}
          <App
            key={screen.id}
            loader={screen.loader}
            {...(screen.topicSource === null ? {} : { topicSource: screen.topicSource })}
            {...(screen.initialTopicSession === null
              ? {}
              : { initialTopicSession: screen.initialTopicSession })}
            title={screen.title}
            selfNames={screen.selfNames}
            identity={screen.identity}
            notice={screen.notice}
            {...(screen.pollIntervalMs === undefined
              ? {}
              : { pollIntervalMs: screen.pollIntervalMs })}
            onOpenSettings={() => {
              void showSettings(screen);
            }}
            {...(screen.source === null ? {} : { source: screen.source })}
            {...(openLocalFolder === null && openLocalFileList === undefined
              ? {}
              : {
                  onPickLocalFolder: () => {
                    if (openLocalFolder !== null) void chooseLocalFolder(screen);
                    else beginFilePick(screen);
                  },
                })}
            {...(screen.liveDemo === null ? {} : { onCheckLiveNow: () => checkLiveNow(screen) })}
            {...(screen.demo && !screen.signedIn
              ? {
                  onUseToken: () => {
                    void showSettings(screen, { focusToken: true, demo: true });
                  },
                }
              : {})}
            limitHit={screen.limitHit}
            {...(screen.signedIn
              ? {
                  signedIn: {
                    onRemove: () => {
                      void removeToken(screen);
                    },
                  },
                }
              : {})}
          />
        </>
      );
  }
}

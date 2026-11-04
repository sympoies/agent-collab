// Switches between the settings screen and the viewer. Secrets go straight from
// the credential store into the message source; they are never kept in React state.

import { useRef, useState } from "react";

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
}

export interface RootProps extends SettingsDeps {
  readonly createSource: (settings: ViewerSettings, token: Secret) => MessageSource;
  readonly createDemoSource: () => MessageSource;
  /** The live demo source; the token, when there is one, is only sent to the API host. */
  readonly createLiveDemoSource: (token: Secret | null) => MessageSource;
  /** Opens the browser's folder picker; null when the browser has none. Needs a user gesture. */
  readonly openLocalFolder: (() => Promise<LocalFolderOpen>) | null;
}

interface ViewerScreen {
  readonly kind: "viewer";
  /** Distinct per opened viewer, so reopening the same repository starts fresh. */
  readonly id: number;
  readonly loader: Loader;
  readonly topicSource: MessageSource | null;
  readonly initialTopicSession: TopicSession | null;
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
}

/** The demos neither read nor write browser storage, so identity choices last for the view. */
const MEMORY_ONLY = { storage: null, key: "demo" } as const;

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
  const { createSource, createDemoSource, createLiveDemoSource, openLocalFolder } = props;
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

  const viewer = (
    loader: Loader,
    title: AppProps["title"],
    selfNames: readonly string[],
    identity: ViewerScreen["identity"],
    notice: string | MessageRef | null = null,
    pollIntervalMs?: number,
    liveDemo: StaticDemoView | null = null,
    source: SourceIndicator | null = null,
    extras: Partial<Pick<ViewerScreen, "demo" | "limitHit" | "signedIn">> = {},
    topicSource: MessageSource | null = null,
    initialTopicSession: TopicSession | null = null,
  ): ViewerScreen => {
    viewers.current += 1;
    return {
      kind: "viewer",
      id: viewers.current,
      loader,
      topicSource,
      initialTopicSession,
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
      { signedIn: true },
      source,
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

  /**
   * Picks and opens a local folder. The picker is called first, straight from the click, because
   * it needs the user gesture. Nothing is saved: the handle lives only in this view.
   */
  const chooseLocalFolder = async (current: ViewerScreen | null): Promise<void> => {
    if (openLocalFolder === null) return;
    // Picking and reading a large clone take time; if the user went elsewhere meanwhile, the
    // result is dropped instead of replacing what they are looking at.
    const operation = ++navigation.current;
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
      opened = await openLocalFolder();
    } catch (error) {
      // Cancelling and a refused sensitive folder both reject; the reason is never shown. A page
      // the browser does not trust with folders is told apart from a cancelled picker.
      refuse(
        error instanceof DOMException && error.name === "SecurityError"
          ? { key: "local.blocked" }
          : { key: "local.noFolder" },
      );
      return;
    }
    const loader = new Loader(opened.source);
    const initialTopicSession = new TopicSession(opened.source);
    try {
      await initialTopicSession.open();
      if (initialTopicSession.inboxLayout !== "topic") {
        const head = initialTopicSession.currentHead;
        if (head !== null) await loader.openWithHead(head);
      }
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
        MEMORY_ONLY,
        null,
        undefined,
        null,
        {
          label: "bar.localFolder",
          experimental: true,
        },
        {},
        opened.source,
        initialTopicSession,
      ),
    );
  };

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
        <div className="app settings">
          <header className="bar settings-bar">
            <h1>{t("app.title")}</h1>
            <div className="bar-actions">
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
          </header>
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
          {openLocalFolder === null ? (
            <p className="local-unsupported note">{t("welcome.localUnsupported")}</p>
          ) : (
            <button
              type="button"
              onClick={() => {
                void chooseLocalFolder(null);
              }}
            >
              {t("welcome.openLocal")}
            </button>
          )}
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
          {...(openLocalFolder === null
            ? {}
            : {
                onPickLocalFolder: () => {
                  void chooseLocalFolder(screen);
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
      );
  }
}

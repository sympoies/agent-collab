// Switches between the settings screen and the viewer. Secrets go straight from
// the credential store into the message source; they are never kept in React state.

import { useRef, useState } from "react";

import type { Secret } from "../credentials/secret";
import { Loader, SetupError } from "../loader/loader";
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
import { demoFiles } from "../demo/fixtures";
import type { MessageSource } from "../source/types";
import { App, type AppProps, type SourceIndicator } from "./App";
import { SettingsView } from "./SettingsView";
import { ThemeToggle } from "./ThemeProvider";

/** A folder the user picked: the source that reads it and its display name. */
export interface LocalFolderOpen {
  readonly source: MessageSource;
  readonly name: string;
}

const NO_FOLDER = "No folder selected, or the browser does not allow this folder.";
const NOT_A_CLONE =
  "This folder is not a collaboration clone (no .agent-collab file). Choose the clone folder itself.";

export interface RootProps extends SettingsDeps {
  readonly createSource: (settings: ViewerSettings, token: Secret) => MessageSource;
  readonly createDemoSource: () => MessageSource;
  readonly createLiveDemoSource: () => MessageSource;
  /** Opens the browser's folder picker; null when the browser has none. Needs a user gesture. */
  readonly openLocalFolder: (() => Promise<LocalFolderOpen>) | null;
}

interface ViewerScreen {
  readonly kind: "viewer";
  /** Distinct per opened viewer, so reopening the same repository starts fresh. */
  readonly id: number;
  readonly loader: Loader;
  readonly title: string;
  readonly selfNames: ReadonlySet<string>;
  readonly identity: AppProps["identity"];
  readonly notice: string | null;
  readonly pollIntervalMs: number | undefined;
  /** The static demo copy on screen, or null for every other viewer, live demo included. */
  readonly liveDemo: StaticDemoView | null;
  /** Names the source when it is not a repository, such as a local folder. */
  readonly source: SourceIndicator | null;
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
    }
  | ViewerScreen;

export function Root(props: RootProps) {
  const { createSource, createDemoSource, createLiveDemoSource, openLocalFolder } = props;
  const [screen, setScreen] = useState<Screen>({ kind: "welcome" });
  const viewers = useRef(0);
  const navigation = useRef(0);
  // Page-session state of the public demo: API requests are spaced across every
  // open and check, and a live copy once read replaces the static copies for good.
  const [liveGate] = useState(() => new LiveCheckGate());
  const liveLoader = useRef<Loader | null>(null);
  /** Why a folder could not be opened, shown on the welcome screen. */
  const [localMessage, setLocalMessage] = useState<string | null>(null);

  const viewer = (
    loader: Loader,
    title: string,
    selfNames: readonly string[],
    identity: ViewerScreen["identity"],
    notice: string | null = null,
    pollIntervalMs?: number,
    liveDemo: StaticDemoView | null = null,
    source: SourceIndicator | null = null,
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
    };
  };

  const open = ({ settings, token }: OpenSettings, notice: string | null = null) =>
    viewer(
      new Loader(createSource(settings, token)),
      settings.repository,
      settings.selfNames,
      {
        storage: props.storage,
        key: `${settings.platform}:${settings.endpoint}/${settings.repository}`,
      },
      notice,
    );

  const showSettings = async (back: ViewerScreen | null) => {
    const operation = ++navigation.current;
    const settings = loadSettings(props.storage);
    const draft = settings === null ? DEFAULT_DRAFT : draftFromSettings(settings);
    const stored = await storedEndpoints(props);
    if (operation !== navigation.current) return;
    setScreen({ kind: "settings", draft, storedEndpoints: stored, back });
  };

  const openSavedRepository = async () => {
    const operation = ++navigation.current;
    try {
      const opened = await restore(props);
      if (operation !== navigation.current) return;
      if (opened === null) await showSettings(null);
      else setScreen(open(opened));
    } catch {
      if (operation !== navigation.current) return;
      await showSettings(null);
    }
  };

  const liveViewer = (loader: Loader, notice: string): ViewerScreen =>
    viewer(loader, "Live demo", [], MEMORY_ONLY, notice, LIVE_DEMO_POLL_INTERVAL_MS);

  const showLiveDemo = () => {
    const operation = ++navigation.current;
    if (liveLoader.current !== null) {
      setScreen(liveViewer(liveLoader.current, "Showing the live repository."));
      return;
    }
    void openLiveDemo(createLiveDemoSource, demoFiles, liveGate).then((result) => {
      if (result.view.kind === "live") liveLoader.current = result.loader;
      if (operation !== navigation.current) return;
      setScreen(
        result.view.kind === "live"
          ? liveViewer(result.loader, result.banner)
          : viewer(
              result.loader,
              "Live demo",
              [],
              MEMORY_ONLY,
              result.banner,
              LIVE_DEMO_POLL_INTERVAL_MS,
              result.view,
            ),
      );
    });
  };

  const checkLiveNow = async (current: ViewerScreen): Promise<void> => {
    if (current.liveDemo === null) return;
    const result = await checkLive(createLiveDemoSource, current.liveDemo, liveGate);
    if (result.loader !== null) liveLoader.current = result.loader;
    const next =
      result.loader === null
        ? { ...current, notice: result.notice }
        : liveViewer(result.loader, result.notice);
    // Leave a viewer the user has since navigated away from alone.
    setScreen((previous) =>
      previous.kind === "viewer" && previous.id === current.id ? next : previous,
    );
  };

  /**
   * Picks and opens a local folder. The picker is called first, straight from the click, because
   * it needs the user gesture. Nothing is saved: the handle lives only in this view.
   */
  const chooseLocalFolder = async (current: ViewerScreen | null): Promise<void> => {
    if (openLocalFolder === null) return;
    const refuse = (message: string) => {
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
    } catch {
      // Cancelling and a refused sensitive folder both reject; the reason is never shown.
      refuse(NO_FOLDER);
      return;
    }
    const loader = new Loader(opened.source);
    try {
      await loader.open();
    } catch (error) {
      refuse(error instanceof SetupError ? NOT_A_CLONE : "This folder could not be read.");
      return;
    }
    setLocalMessage(null);
    navigation.current += 1;
    setScreen(
      viewer(loader, `Local folder: ${opened.name}`, [], MEMORY_ONLY, null, undefined, null, {
        label: "Local folder",
        experimental: true,
      }),
    );
  };

  const save = async (draft: SettingsDraft): Promise<DraftErrors | null> => {
    const operation = ++navigation.current;
    const result = await apply(props, draft);
    if (operation !== navigation.current) return null;
    if (!result.ok) return result.errors;
    setScreen(open(result.open, result.warning));
    return null;
  };

  switch (screen.kind) {
    case "welcome":
      return (
        <div className="app settings">
          <header className="bar settings-bar">
            <h1>Agent collaboration viewer</h1>
            <div className="bar-actions">
              <ThemeToggle />
            </div>
          </header>
          <button type="button" onClick={showLiveDemo}>
            Open live demo
          </button>
          {openLocalFolder === null ? (
            <p className="local-unsupported note">
              Opening a local folder needs a browser that can open folders, such as Chrome or Edge
              on a computer.
            </p>
          ) : (
            <button
              type="button"
              onClick={() => {
                void chooseLocalFolder(null);
              }}
            >
              Open local folder (experimental)
            </button>
          )}
          {localMessage !== null && (
            <p className="error" role="alert">
              {localMessage}
            </p>
          )}
          <button type="button" onClick={() => void openSavedRepository()}>
            Open saved repository
          </button>
          <button
            type="button"
            onClick={() => {
              void showSettings(null);
            }}
          >
            Open another repository
          </button>
        </div>
      );
    case "settings": {
      const back = screen.back;
      return (
        <div className="app">
          <header className="bar settings-bar">
            <h1>Collab Viewer</h1>
            <div className="bar-actions">
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
                        ? liveViewer(liveLoader.current, "Showing the live repository.")
                        : back,
                    );
                  }
            }
            onOpenDemo={() => {
              setScreen(
                viewer(
                  new Loader(createDemoSource()),
                  "Demo repository",
                  ["alice-agent"],
                  MEMORY_ONLY,
                ),
              );
            }}
            onOpenLiveDemo={() => {
              showLiveDemo();
            }}
          />
        </div>
      );
    }
    case "viewer":
      return (
        <App
          key={screen.id}
          loader={screen.loader}
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
        />
      );
  }
}

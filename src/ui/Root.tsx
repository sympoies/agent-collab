// Switches between the settings screen and the viewer. Secrets go straight from
// the credential store into the message source; they are never kept in React state.

import { useRef, useState } from "react";

import type { Secret } from "../credentials/secret";
import { Loader } from "../loader/loader";
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
import { LIVE_DEMO_POLL_INTERVAL_MS, openLiveDemo } from "../settings/live-demo";
import type { LiveDemoOpen } from "../settings/live-demo";
import { demoFiles } from "../demo/fixtures";
import { DemoFallbackSource } from "../source/demo-fallback";
import { SourceError, type MessageSource } from "../source/types";
import { App } from "./App";
import { SettingsView } from "./SettingsView";
import { ThemeToggle } from "./ThemeProvider";

export interface RootProps extends SettingsDeps {
  readonly createSource: (settings: ViewerSettings, token: Secret) => MessageSource;
  readonly createDemoSource: () => MessageSource;
  readonly createLiveDemoSource: () => MessageSource;
}

interface ViewerScreen {
  readonly kind: "viewer";
  /** Distinct per opened viewer, so reopening the same repository starts fresh. */
  readonly id: number;
  readonly loader: Loader;
  readonly title: string;
  readonly selfNames: ReadonlySet<string>;
  readonly notice: string | null;
  readonly pollIntervalMs: number | undefined;
  readonly liveDemo: {
    readonly fallbackSource: MessageSource;
    readonly generatedAt: string | null;
  } | null;
}

function fallbackBanner(error: SourceError, generatedAt: string | null): string {
  const reason =
    error.kind === "rate-limited"
      ? "The live check hit GitHub's API limit"
      : "The live check is unavailable";
  const content =
    generatedAt === null
      ? "showing the bundled sample"
      : `showing the snapshot generated at ${generatedAt}`;
  return error.retryAt === null
    ? `${reason}; ${content}.`
    : `${reason}. Reset at ${error.retryAt.toLocaleString()}; ${content}.`;
}

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
  const { createSource, createDemoSource, createLiveDemoSource } = props;
  const [screen, setScreen] = useState<Screen>({ kind: "welcome" });
  const viewers = useRef(0);
  const navigation = useRef(0);

  const viewer = (
    source: MessageSource,
    title: string,
    selfNames: readonly string[],
    notice: string | null = null,
    pollIntervalMs?: number,
    liveDemo: ViewerScreen["liveDemo"] = null,
    existingLoader?: Loader,
  ): ViewerScreen => {
    viewers.current += 1;
    return {
      kind: "viewer",
      id: viewers.current,
      loader: existingLoader ?? new Loader(source),
      title,
      selfNames: new Set(selfNames),
      notice,
      pollIntervalMs,
      liveDemo,
    };
  };

  const open = ({ settings, token }: OpenSettings, notice: string | null = null) =>
    viewer(createSource(settings, token), settings.repository, settings.selfNames, notice);

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

  const showLiveDemo = () => {
    const operation = ++navigation.current;
    void openLiveDemo(createLiveDemoSource, demoFiles).then((result: LiveDemoOpen) => {
      if (operation !== navigation.current) return;
      setScreen(
        viewer(
          result.fallbackSource,
          "Live demo",
          [],
          result.banner,
          LIVE_DEMO_POLL_INTERVAL_MS,
          { fallbackSource: result.fallbackSource, generatedAt: result.generatedAt },
          result.loader,
        ),
      );
    });
  };

  const checkLiveNow = async (current: ViewerScreen): Promise<void> => {
    if (current.liveDemo === null) return;
    const nextId = ++viewers.current;
    let fallbackError: SourceError | null = null;
    const source = new DemoFallbackSource(
      createLiveDemoSource(),
      current.liveDemo.fallbackSource,
      (error) => {
        fallbackError = error;
        setScreen((previous) =>
          previous.kind === "viewer" && previous.id === nextId
            ? { ...previous, notice: fallbackBanner(error, current.liveDemo?.generatedAt ?? null) }
            : previous,
        );
      },
    );
    let loader = new Loader(source);
    try {
      await loader.open();
    } catch (error) {
      fallbackError = error instanceof SourceError ? error : null;
      loader = new Loader(current.liveDemo.fallbackSource);
      await loader.open();
    }
    setScreen({
      ...current,
      id: nextId,
      loader,
      notice:
        fallbackError === null
          ? "Checked the live repository."
          : fallbackBanner(fallbackError, current.liveDemo.generatedAt),
    });
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
                    setScreen(back);
                  }
            }
            onOpenDemo={() => {
              setScreen(viewer(createDemoSource(), "Demo repository", ["alice-agent"]));
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
          notice={screen.notice}
          {...(screen.pollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: screen.pollIntervalMs })}
          onOpenSettings={() => {
            void showSettings(screen);
          }}
          {...(screen.liveDemo === null ? {} : { onCheckLiveNow: () => checkLiveNow(screen) })}
        />
      );
  }
}

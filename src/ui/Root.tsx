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
import type { MessageSource } from "../source/types";
import { App } from "./App";
import { SettingsView } from "./SettingsView";

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

  const viewer = (
    source: MessageSource,
    title: string,
    selfNames: readonly string[],
    notice: string | null = null,
    pollIntervalMs?: number,
  ): ViewerScreen => {
    viewers.current += 1;
    return {
      kind: "viewer",
      id: viewers.current,
      loader: new Loader(source),
      title,
      selfNames: new Set(selfNames),
      notice,
      pollIntervalMs,
    };
  };

  const open = ({ settings, token }: OpenSettings, notice: string | null = null) =>
    viewer(createSource(settings, token), settings.repository, settings.selfNames, notice);

  const showSettings = async (back: ViewerScreen | null) => {
    const settings = loadSettings(props.storage);
    const draft = settings === null ? DEFAULT_DRAFT : draftFromSettings(settings);
    const stored = await storedEndpoints(props);
    setScreen({ kind: "settings", draft, storedEndpoints: stored, back });
  };

  const openSavedRepository = async () => {
    try {
      const opened = await restore(props);
      if (opened === null) await showSettings(null);
      else setScreen(open(opened));
    } catch {
      await showSettings(null);
    }
  };

  const showLiveDemo = () => {
    openLiveDemo(createLiveDemoSource, (source) => {
      setScreen(viewer(source, "Live demo", [], null, LIVE_DEMO_POLL_INTERVAL_MS));
    });
  };

  const save = async (draft: SettingsDraft): Promise<DraftErrors | null> => {
    const result = await apply(props, draft);
    if (!result.ok) return result.errors;
    setScreen(open(result.open, result.warning));
    return null;
  };

  switch (screen.kind) {
    case "welcome":
      return (
        <div className="app settings">
          <h1>Agent collaboration viewer</h1>
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
          <SettingsView
            initial={screen.draft}
            storedEndpoints={screen.storedEndpoints}
            onSave={save}
            onRemoveCredentials={async () => {
              await removeCredentials(props);
              await showSettings(null);
            }}
            onCancel={
              back === null
                ? null
                : () => {
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
        />
      );
  }
}

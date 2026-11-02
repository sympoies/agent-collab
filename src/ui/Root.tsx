// Switches between the settings screen and the viewer. Secrets go straight from
// the credential store into the message source; they are never kept in React state.

import { useEffect, useState } from "react";

import type { Secret } from "../credentials/secret";
import { Loader } from "../loader/loader";
import {
  DEFAULT_DRAFT,
  draftFromSettings,
  loadSettings,
  type DraftErrors,
  type SettingsDraft,
  type ViewerSettings,
} from "../settings/model";
import {
  apply,
  removeCredentials,
  restore,
  tokenStored,
  type OpenSettings,
  type SettingsDeps,
} from "../settings/session";
import type { MessageSource } from "../source/types";
import { App } from "./App";
import { SettingsView } from "./SettingsView";

export interface RootProps extends SettingsDeps {
  readonly createSource: (settings: ViewerSettings, token: Secret) => MessageSource;
  readonly createDemoSource: () => MessageSource;
}

interface ViewerScreen {
  readonly kind: "viewer";
  readonly loader: Loader;
  readonly title: string;
  readonly selfNames: ReadonlySet<string>;
}

type Screen =
  | { readonly kind: "starting" }
  | {
      readonly kind: "settings";
      readonly draft: SettingsDraft;
      readonly tokenStored: boolean;
      /** The viewer to return to on cancel. */
      readonly back: ViewerScreen | null;
    }
  | ViewerScreen;

export function Root(props: RootProps) {
  const { createSource, createDemoSource } = props;
  const [screen, setScreen] = useState<Screen>({ kind: "starting" });

  const viewer = ({ settings, token }: OpenSettings): ViewerScreen => ({
    kind: "viewer",
    loader: new Loader(createSource(settings, token)),
    title: settings.repository,
    selfNames: new Set(settings.selfNames),
  });

  const showSettings = async (back: ViewerScreen | null) => {
    const settings = loadSettings(props.storage);
    const draft = settings === null ? DEFAULT_DRAFT : draftFromSettings(settings);
    const stored = await tokenStored(props, draft.credentialStorage);
    setScreen({ kind: "settings", draft, tokenStored: stored, back });
  };

  useEffect(() => {
    void restore(props).then(async (open) => {
      if (open === null) await showSettings(null);
      else setScreen(viewer(open));
    });
    // Runs once at start-up; later changes go through the settings screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (draft: SettingsDraft): Promise<DraftErrors | null> => {
    const result = await apply(props, draft);
    if (!result.ok) return result.errors;
    setScreen(viewer(result.open));
    return null;
  };

  switch (screen.kind) {
    case "starting":
      return <p className="empty">Loading…</p>;
    case "settings": {
      const back = screen.back;
      return (
        <div className="app">
          <SettingsView
            initial={screen.draft}
            tokenStored={screen.tokenStored}
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
              setScreen({
                kind: "viewer",
                loader: new Loader(createDemoSource()),
                title: "Demo repository",
                selfNames: new Set(["alice-agent"]),
              });
            }}
          />
        </div>
      );
    }
    case "viewer":
      return (
        <App
          key={screen.title}
          loader={screen.loader}
          title={screen.title}
          selfNames={screen.selfNames}
          onOpenSettings={() => {
            void showSettings(screen);
          }}
        />
      );
  }
}

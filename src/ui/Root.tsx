// Switches between the settings screen and the viewer. Secrets go straight from
// the credential store into the message source; they are never kept in React state.

import { useEffect, useRef, useState } from "react";

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
  storedTokens,
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
  /** Distinct per opened viewer, so reopening the same repository starts fresh. */
  readonly id: number;
  readonly loader: Loader;
  readonly title: string;
  readonly selfNames: ReadonlySet<string>;
  readonly notice: string | null;
}

type Screen =
  | { readonly kind: "starting" }
  | {
      readonly kind: "settings";
      readonly draft: SettingsDraft;
      readonly tokenStored: Readonly<Record<CredentialStorage, boolean>>;
      /** The viewer to return to on cancel. */
      readonly back: ViewerScreen | null;
    }
  | ViewerScreen;

export function Root(props: RootProps) {
  const { createSource, createDemoSource } = props;
  const [screen, setScreen] = useState<Screen>({ kind: "starting" });
  const viewers = useRef(0);

  const viewer = (
    source: MessageSource,
    title: string,
    selfNames: readonly string[],
    notice: string | null = null,
  ): ViewerScreen => {
    viewers.current += 1;
    return {
      kind: "viewer",
      id: viewers.current,
      loader: new Loader(source),
      title,
      selfNames: new Set(selfNames),
      notice,
    };
  };

  const open = ({ settings, token }: OpenSettings, notice: string | null = null) =>
    viewer(createSource(settings, token), settings.repository, settings.selfNames, notice);

  const showSettings = async (back: ViewerScreen | null) => {
    const settings = loadSettings(props.storage);
    const draft = settings === null ? DEFAULT_DRAFT : draftFromSettings(settings);
    const stored = await storedTokens(props, draft.endpoint);
    setScreen({ kind: "settings", draft, tokenStored: stored, back });
  };

  useEffect(() => {
    // Any start-up failure (a blocked credential store, a source that cannot be
    // created) falls through to the settings screen instead of a stuck screen.
    restore(props)
      .then(async (opened) => {
        if (opened === null) await showSettings(null);
        else setScreen(open(opened));
      })
      .catch(() => showSettings(null));
    // Runs once at start-up; later changes go through the settings screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (draft: SettingsDraft): Promise<DraftErrors | null> => {
    const result = await apply(props, draft);
    if (!result.ok) return result.errors;
    setScreen(open(result.open, result.warning));
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
              setScreen(viewer(createDemoSource(), "Demo repository", ["alice-agent"]));
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
          onOpenSettings={() => {
            void showSettings(screen);
          }}
        />
      );
  }
}

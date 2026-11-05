// The settings screen's data-source section: every way to get messages, each with its own action,
// and "Forget what this browser remembers". The GitHub connection form follows it (SettingsView).

import { useState, type ReactNode } from "react";

import { useT } from "../i18n/LocaleProvider";
import type { MessageRef } from "../i18n/translate";
import { say } from "./errorText";
import { SharedCard, SharedLink } from "./shared/components";

export interface DataSourcesProps {
  /** Opens the snapshot this deployment serves; null when it serves none. */
  readonly hosted: (() => void) | null;
  readonly local: {
    /** The browser's folder picker; null where the browser has none. */
    readonly pickFolder: (() => void) | null;
    /** The file chooser fallback; null where it is not offered. */
    readonly pickFiles: (() => void) | null;
    /** Why the last folder could not be opened. */
    readonly message: MessageRef | null;
    /** The remembered folder's Reopen and Forget. */
    readonly remembered: ReactNode;
  };
  readonly onLiveDemo: () => void;
  readonly onOfflineDemo: () => void;
}

export function DataSources(props: DataSourcesProps) {
  const t = useT();
  const { local } = props;
  return (
    <section className="data-sources" aria-labelledby="sources-heading">
      <h2 id="sources-heading">{t("sources.heading")}</h2>
      <p className="note">{t("sources.intro")}</p>
      {props.hosted !== null && (
        <SharedCard className="source-card">
          <h3>{t("welcome.hostedHeading")}</h3>
          <p className="note">{t("sources.hostedText")}</p>
          <button type="button" onClick={props.hosted}>
            {t("welcome.openHosted")}
          </button>
        </SharedCard>
      )}
      <SharedCard className="source-card">
        <h3>{t("sources.githubTitle")}</h3>
        <p className="note">{t("sources.githubText")}</p>
        <SharedLink href="#github-form">{t("sources.githubLink")}</SharedLink>
      </SharedCard>
      <div data-source="local">
        <SharedCard className="source-card">
          <h3>{t("sources.localTitle")}</h3>
          <p className="note">{t("sources.localText")}</p>
          {local.pickFolder !== null && (
            <button type="button" onClick={local.pickFolder}>
              {t("welcome.openLocal")}
            </button>
          )}
          {local.pickFolder === null && local.pickFiles !== null && (
            <button type="button" onClick={local.pickFiles}>
              {t("welcome.openLocalFiles")}
            </button>
          )}
          {local.pickFolder === null && (
            <p className="local-unsupported note">{t("welcome.localUnsupported")}</p>
          )}
          {local.message !== null && (
            <p className="error" role="alert">
              {say(local.message, t)}
            </p>
          )}
          {local.remembered}
        </SharedCard>
      </div>
      <SharedCard className="source-card">
        <h3>{t("sources.liveTitle")}</h3>
        <p className="note">{t("sources.liveText")}</p>
        <button type="button" onClick={props.onLiveDemo}>
          {t("welcome.openLiveDemo")}
        </button>
      </SharedCard>
      <SharedCard className="source-card">
        <h3>{t("sources.offlineTitle")}</h3>
        <p className="note">{t("sources.offlineText")}</p>
        <button type="button" onClick={props.onOfflineDemo}>
          {t("settings.openOffline")}
        </button>
      </SharedCard>
    </section>
  );
}

/** "Forget what this browser remembers": asks first, then forgets and says so. */
export function ForgetSection({ onForget }: { readonly onForget: () => Promise<void> }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <section className="forget-all" aria-labelledby="forget-heading">
      <h2 id="forget-heading">{t("forget.heading")}</h2>
      <p className="note">{t("forget.text")}</p>
      {!confirming && (
        <button
          type="button"
          onClick={() => {
            setForgotten(false);
            setFailed(false);
            setConfirming(true);
          }}
        >
          {t("forget.button")}
        </button>
      )}
      {confirming && (
        <div className="actions" role="group" aria-label={t("forget.heading")}>
          <button
            type="button"
            className="danger"
            onClick={() => {
              onForget()
                .then(() => {
                  setForgotten(true);
                })
                .catch(() => {
                  setFailed(true);
                })
                .finally(() => {
                  setConfirming(false);
                });
            }}
          >
            {t("forget.confirm")}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
            }}
          >
            {t("settings.cancel")}
          </button>
        </div>
      )}
      {forgotten && (
        <p className="note" role="status">
          {t("forget.done")}
        </p>
      )}
      {failed && (
        <p className="error" role="alert">
          {t("forget.failed")}
        </p>
      )}
    </section>
  );
}

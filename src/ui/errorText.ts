// What the user reads for a failure: derived from the error's kind and data, never from the
// error's English message, which is meant for developers.

import type { Translate } from "../i18n/LocaleProvider";
import type { MessageRef } from "../i18n/translate";
import { SetupError } from "../loader/loader";
import { SourceError } from "../source/types";

function isMessageRef(value: unknown): value is MessageRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "key" in value &&
    typeof value.key === "string" &&
    !(value instanceof Error)
  );
}

/** A plain text or a message to say in the current language. */
export function say(value: string | MessageRef, t: Translate): string {
  return typeof value === "string" ? value : t(value.key, value.params);
}

export function errorText(
  error: unknown,
  t: Translate,
  formatDateTime: (date: Date) => string,
): string {
  if (typeof error === "string") return error;
  if (isMessageRef(error)) return t(error.key, error.params);
  if (error instanceof SetupError) {
    return error.code === "no-marker"
      ? t("error.setupNoMarker")
      : t("error.setupProtocol", { detail: error.detail });
  }
  if (error instanceof SourceError) {
    switch (error.kind) {
      case "unauthorized":
        return t(
          error.code === "anonymous-needs-token" ? "error.needsToken" : "error.unauthorized",
        );
      case "forbidden":
        if (error.code === "local-permission") return t("error.localPermission");
        return t(
          error.code === "anonymous-forbidden" ? "error.forbiddenAnonymous" : "error.forbidden",
        );
      case "not-found":
        return t(error.code === "anonymous-needs-token" ? "error.needsToken" : "error.notFound");
      case "rate-limited":
        return error.retryAt === null
          ? t("error.rateLimitedLater")
          : t("error.rateLimited", { time: formatDateTime(error.retryAt) });
      case "unreachable":
        return t("error.unreachable");
      case "too-large":
        return t("error.tooLarge");
      case "unexpected":
        return t("error.unexpected");
    }
  }
  return t("error.unexpected");
}

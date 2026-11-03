// What the user reads for a failure: derived from the error's kind and data, never from the
// error's English message, which is meant for developers.

import type { Translate } from "../i18n/LocaleProvider";
import { SetupError } from "../loader/loader";
import { SourceError } from "../source/types";

export function errorText(
  error: unknown,
  t: Translate,
  formatDateTime: (date: Date) => string,
): string {
  if (typeof error === "string") return error;
  if (error instanceof SetupError) {
    return error.code === "no-marker"
      ? t("error.setupNoMarker")
      : t("error.setupProtocol", { detail: error.detail });
  }
  if (error instanceof SourceError) {
    switch (error.kind) {
      case "unauthorized":
        return t("error.unauthorized");
      case "forbidden":
        return t("error.forbidden");
      case "not-found":
        return t("error.notFound");
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

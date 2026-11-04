import { describe, expect, it } from "vitest";

import { LOCALES, type Locale } from "../src/i18n/catalog";
import { translate } from "../src/i18n/translate";
import { SetupError } from "../src/loader/loader";
import { SourceError, type SourceErrorCode, type SourceErrorKind } from "../src/source/types";
import { errorText, say } from "../src/ui/errorText";

const RESET = new Date("2026-11-03T08:05:00Z");

function text(locale: Locale, error: unknown): string {
  return errorText(
    error,
    (key, params) => translate(locale, key, params),
    (date) => date.toISOString(),
  );
}

function source(
  kind: SourceErrorKind,
  code: SourceErrorCode | null = null,
  retryAt: Date | null = null,
) {
  return new SourceError(kind, "x", null, retryAt, "developer text", code);
}

/** Concrete wording per locale: swapping two kinds, or dropping a parameter, fails here. */
const CASES: ReadonlyArray<readonly [string, unknown, Record<Locale, string>]> = [
  [
    "unauthorized",
    source("unauthorized"),
    {
      en: "The token was rejected. Check that it is valid and has not expired.",
      ja: "トークンが拒否されました。有効で期限切れでないか確認してください。",
      "zh-TW": "權杖被拒絕。請確認它有效且未過期。",
    },
  ],
  [
    "forbidden with a token",
    source("forbidden"),
    {
      en: "Access was denied. Check repository visibility or token permissions.",
      ja: "アクセスが拒否されました。リポジトリの公開設定かトークンの権限を確認してください。",
      "zh-TW": "存取遭拒。請檢查儲存庫的可見性或權杖權限。",
    },
  ],
  [
    "forbidden without a token",
    source("forbidden", "anonymous-forbidden"),
    {
      en: "Access was denied. Check that the repository is public.",
      ja: "アクセスが拒否されました。リポジトリが公開されているか確認してください。",
      "zh-TW": "存取遭拒。請確認儲存庫是公開的。",
    },
  ],
  [
    "forbidden for a local folder",
    source("forbidden", "local-permission"),
    {
      en: "Local folder permission needs to be granted again. Choose the folder again from the toolbar.",
      ja: "ローカルフォルダーの権限をもう一度許可する必要があります。ツールバーからフォルダーを選び直してください。",
      "zh-TW": "需要重新授予本機資料夾的權限。請從工具列重新選擇資料夾。",
    },
  ],
  [
    "not found",
    source("not-found"),
    {
      en: "Not found. Check the repository name and branch.",
      ja: "見つかりません。リポジトリ名とブランチを確認してください。",
      "zh-TW": "找不到。請檢查儲存庫名稱與分支。",
    },
  ],
  [
    "anonymous 404",
    source("not-found", "anonymous-needs-token"),
    {
      en: "This repository needs a token or does not exist.",
      ja: "このリポジトリはトークンが必要か、存在しません。",
      "zh-TW": "此儲存庫需要權杖，或不存在。",
    },
  ],
  [
    "anonymous 401",
    source("unauthorized", "anonymous-needs-token"),
    {
      en: "This repository needs a token or does not exist.",
      ja: "このリポジトリはトークンが必要か、存在しません。",
      "zh-TW": "此儲存庫需要權杖，或不存在。",
    },
  ],
  [
    "rate limited with a reset time",
    source("rate-limited", null, RESET),
    {
      en: "The request limit is reached. Try again after 2026-11-03T08:05:00.000Z.",
      ja: "リクエスト数の上限に達しました。2026-11-03T08:05:00.000Z 以降にもう一度お試しください。",
      "zh-TW": "已達請求上限。請在 2026-11-03T08:05:00.000Z 之後再試。",
    },
  ],
  [
    "rate limited without a reset time",
    source("rate-limited"),
    {
      en: "The request limit is reached. Try again later.",
      ja: "リクエスト数の上限に達しました。しばらくしてからもう一度お試しください。",
      "zh-TW": "已達請求上限。請稍後再試。",
    },
  ],
  [
    "unreachable",
    source("unreachable"),
    {
      en: "Could not reach the server. Check your connection.",
      ja: "サーバーに接続できません。接続を確認してください。",
      "zh-TW": "無法連線到伺服器。請檢查網路連線。",
    },
  ],
  [
    "too large",
    source("too-large"),
    {
      en: "This is too large to read.",
      ja: "大きすぎて読み込めません。",
      "zh-TW": "內容太大，無法讀取。",
    },
  ],
  [
    "unexpected",
    source("unexpected"),
    {
      en: "Unexpected error while loading messages.",
      ja: "メッセージの読み込み中に予期しないエラーが起きました。",
      "zh-TW": "載入訊息時發生未預期的錯誤。",
    },
  ],
  [
    "setup: no marker",
    new SetupError("x", "no-marker"),
    {
      en: "This is not a collaboration repository (no .agent-collab file).",
      ja: "共同作業用のリポジトリではありません（.agent-collab ファイルがありません）。",
      "zh-TW": "這不是協作儲存庫（找不到 .agent-collab 檔案）。",
    },
  ],
  [
    "setup: protocol",
    new SetupError("x", "protocol", "collab-protocol: 2"),
    {
      en: "Unsupported collaboration protocol: collab-protocol: 2",
      ja: "未対応の共同作業プロトコルです: collab-protocol: 2",
      "zh-TW": "不支援的協作協定：collab-protocol: 2",
    },
  ],
  [
    "setup: layout",
    new SetupError("x", "layout", "weekly"),
    {
      en: "Unsupported inbox layout: weekly. This viewer needs to be updated.",
      ja: "未対応の受信箱レイアウトです: weekly。ビューアの更新が必要です。",
      "zh-TW": "不支援的收件匣版面：weekly。需要更新檢視器。",
    },
  ],
  [
    "an unknown kind",
    new SourceError("nonsense" as SourceErrorKind, "x"),
    {
      en: "Unexpected error while loading messages.",
      ja: "メッセージの読み込み中に予期しないエラーが起きました。",
      "zh-TW": "載入訊息時發生未預期的錯誤。",
    },
  ],
  [
    "a plain Error",
    new Error("secret internal detail"),
    {
      en: "Unexpected error while loading messages.",
      ja: "メッセージの読み込み中に予期しないエラーが起きました。",
      "zh-TW": "載入訊息時發生未預期的錯誤。",
    },
  ],
  [
    "a number",
    42,
    {
      en: "Unexpected error while loading messages.",
      ja: "メッセージの読み込み中に予期しないエラーが起きました。",
      "zh-TW": "載入訊息時發生未預期的錯誤。",
    },
  ],
  [
    "null",
    null,
    {
      en: "Unexpected error while loading messages.",
      ja: "メッセージの読み込み中に予期しないエラーが起きました。",
      "zh-TW": "載入訊息時發生未預期的錯誤。",
    },
  ],
];

describe("errorText", () => {
  for (const [name, error, expected] of CASES) {
    for (const locale of LOCALES) {
      it(`words ${name} in ${locale}`, () => {
        expect(text(locale, error)).toBe(expected[locale]);
      });
    }
  }

  it("passes a plain string through and never shows a developer message", () => {
    expect(text("ja", "already worded")).toBe("already worded");
    expect(text("en", source("unauthorized"))).not.toContain("developer text");
  });

  it("says a message reference in the current language", () => {
    const t =
      (locale: Locale) =>
      (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
        translate(locale, key, params);
    expect(say({ key: "local.noFolder" }, t("ja"))).toBe(
      "フォルダーが選ばれていないか、ブラウザーがこのフォルダーを許可していません。",
    );
    expect(say("plain", t("ja"))).toBe("plain");
    expect(errorText({ key: "refresh.busy" }, t("zh-TW"), String)).toBe(
      "已有請求進行中，或正在等待請求上限解除。",
    );
  });
});

// A short, human label for an http(s) URL, derived from the URL text alone: no network request and
// no title lookup. Provider shapes are recognised by path (Jira-style `/browse/KEY-1`, GitLab
// `/-/merge_requests/1`, GitHub `/pull/1`, ...), never by host name, so the rules stay generic.
// The label is plain text for a React child; the full URL belongs in the link's `title`.

import type { Translate } from "../i18n/LocaleProvider";

/** The longest label ever shown; longer text ends with an ellipsis. */
export const URL_LABEL_MAX_LENGTH = 80;

export interface UrlLabel {
  readonly label: string;
  /** The full URL, for the link's `title` attribute. */
  readonly title: string;
}

const NUMBER_RE = /^\d{1,12}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,30}-\d{1,12}$/;

/** Drops control and bidirectional-override characters, then bounds the length. */
function bound(text: string, max = URL_LABEL_MAX_LENGTH): string {
  // eslint-disable-next-line no-control-regex -- control characters are removed on purpose
  const clean = text.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function dashed(segments: readonly string[], keyword: string): number {
  return segments.findIndex((s, i) => s === "-" && segments[i + 1] === keyword);
}

function providerLabel(
  segments: readonly string[],
  query: URLSearchParams,
  t: Translate,
): string | null {
  // Jira style: /browse/PROJ-123, optionally focused on a comment.
  const [first, key, ...rest] = segments;
  if (first === "browse" && key !== undefined && rest.length === 0 && ISSUE_KEY_RE.test(key)) {
    const comment = query.get("focusedCommentId");
    return comment !== null && NUMBER_RE.test(comment)
      ? `${key} · ${t("url.comment", { id: comment })}`
      : key;
  }
  // GitLab: /<group>/.../<project>/-/merge_requests|issues|work_items|commit/<id>
  for (const [keyword, mark] of [
    ["merge_requests", "!"],
    ["issues", "#"],
    ["work_items", "#"],
    ["commit", "@"],
  ] as const) {
    const at = dashed(segments, keyword);
    const project = segments[at - 1];
    const id = segments[at + 2];
    if (at < 1 || project === undefined || id === undefined) continue;
    if (mark === "@" ? SHA_RE.test(id) : NUMBER_RE.test(id)) {
      return `${bound(decode(project), 40)}${mark}${mark === "@" ? id.slice(0, 7) : id}`;
    }
  }
  // GitLab or GitHub file link: .../blob/<ref>/<path>; the label is the file name.
  const blob = segments.indexOf("blob");
  const name = segments[segments.length - 1];
  if (blob >= 2 && segments.length >= blob + 3 && name !== undefined) return bound(decode(name));
  // GitHub: /<owner>/<repo>/pull|issues/<n> or /commit/<sha>
  const [owner, repo, kind, id] = segments;
  if (owner !== undefined && repo !== undefined && id !== undefined) {
    if ((kind === "pull" || kind === "issues") && NUMBER_RE.test(id)) {
      return `${bound(decode(repo), 40)}#${id}`;
    }
    if (kind === "commit" && SHA_RE.test(id)) return `${bound(decode(repo), 40)}@${id.slice(0, 7)}`;
  }
  return null;
}

export function describeUrl(href: string, t: Translate): UrlLabel {
  const title = href;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { label: bound(href), title };
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return { label: bound(href), title };
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const known = providerLabel(segments, url.searchParams, t);
  const shown = known === null ? "" : bound(known).trim();
  if (shown !== "") return { label: shown, title };
  const last = bound(decode(segments[segments.length - 1] ?? ""), URL_LABEL_MAX_LENGTH).trim();
  if (last === "") return { label: bound(url.hostname), title };
  const prefix = `${url.hostname} · …/`;
  const room = Math.max(8, URL_LABEL_MAX_LENGTH - prefix.length);
  return { label: bound(`${prefix}${bound(last, room)}`), title };
}

// GitHub implementation of MessageSource over the Git database REST endpoints
// (docs/design.md, section 3). Only the branch ref is mutable; commits, trees and
// blobs are content-addressed, so they are cached for the session.

import type { Secret } from "../credentials/secret";
import {
  SourceError,
  type DirectoryEntry,
  type Head,
  type MessageSource,
  type RateLimit,
  type SourceErrorKind,
} from "./types";

export interface GitHubSourceConfig {
  /** API base URL, for example https://api.github.com or https://<host>/api/v3. */
  readonly apiBase: string;
  readonly owner: string;
  readonly repo: string;
  /** Branch to watch; null uses the repository's default branch. */
  readonly branch: string | null;
  readonly token?: Secret | null;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

// REST API version this source is written against (an external contract we pin).
const API_VERSION = "2022-11-28";
const JSON_MEDIA = "application/vnd.github+json";
const RAW_MEDIA = "application/vnd.github.raw+json";

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}

interface Tree {
  readonly truncated: boolean;
  readonly tree: readonly TreeEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringAt(value: unknown, ...keys: string[]): string | null {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

function asTree(value: unknown): Tree | null {
  if (!isRecord(value) || !Array.isArray(value.tree)) return null;
  const entries: TreeEntry[] = [];
  for (const entry of value.tree as unknown[]) {
    const path = stringAt(entry, "path");
    const mode = stringAt(entry, "mode");
    const type = stringAt(entry, "type");
    const sha = stringAt(entry, "sha");
    if (path === null || mode === null || type === null || sha === null) return null;
    entries.push({ path, mode, type, sha });
  }
  return { truncated: value.truncated === true, tree: entries };
}

function toEntry(parent: string, entry: TreeEntry): DirectoryEntry | null {
  const path = parent === "" ? entry.path : `${parent}/${entry.path}`;
  // Submodules ("commit") and symlinks (mode 120000) are not message content.
  if (entry.type === "tree") {
    return { name: entry.path, path, kind: "directory", objectId: entry.sha };
  }
  if (entry.type === "blob" && entry.mode !== "120000") {
    return { name: entry.path, path, kind: "file", objectId: entry.sha };
  }
  return null;
}

// URL.canParse is missing in older Android WebViews.
function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export class GitHubSource implements MessageSource {
  private readonly config: GitHubSourceConfig;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly repoUrl: string;
  private branch: Promise<string> | null = null;
  private lastRateLimit: RateLimit | null = null;
  private readonly rootTrees = new Map<string, Promise<string>>();
  private readonly trees = new Map<string, Promise<Tree>>();
  private readonly blobs = new Map<string, Promise<string>>();

  constructor(config: GitHubSourceConfig) {
    this.config = config;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = config.now ?? (() => new Date());
    if (!isHttps(config.apiBase)) throw new Error("The API endpoint must use https.");
    const base = config.apiBase.replace(/\/+$/, "");
    this.repoUrl = `${base}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  }

  async head(previous: Head | null): Promise<Head | "not-modified"> {
    const branch = await this.resolveBranch();
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    const response = await this.request(
      `/git/ref/heads/${ref}`,
      "",
      JSON_MEDIA,
      previous?.validator,
    );
    if (response.status === 304) return "not-modified";
    const revision = stringAt(await this.json(response, ""), "object", "sha");
    if (revision === null) throw new SourceError("unexpected", "", response.status);
    return { revision, validator: response.headers.get("etag") };
  }

  async listDirectory(revision: string, path: string): Promise<readonly DirectoryEntry[]> {
    let sha = await this.rootTree(revision);
    let walked = "";
    for (const segment of path === "" ? [] : path.split("/")) {
      const tree = await this.tree(sha, walked);
      walked = walked === "" ? segment : `${walked}/${segment}`;
      const child = tree.tree.find((entry) => entry.path === segment && entry.type === "tree");
      if (child === undefined) throw new SourceError("not-found", walked);
      sha = child.sha;
    }
    const tree = await this.tree(sha, path);
    return tree.tree.flatMap((entry) => toEntry(path, entry) ?? []);
  }

  readFile(entry: DirectoryEntry): Promise<string> {
    return this.cached(this.blobs, entry.objectId, async () => {
      const response = await this.request(`/git/blobs/${entry.objectId}`, entry.path, RAW_MEDIA);
      return response.text();
    });
  }

  rateLimit(): RateLimit | null {
    return this.lastRateLimit;
  }

  /** Keeps configuration (and the credential) out of serialized output. */
  toJSON(): { provider: string } {
    return { provider: "github" };
  }

  private resolveBranch(): Promise<string> {
    if (this.config.branch !== null) return Promise.resolve(this.config.branch);
    this.branch ??= (async () => {
      const response = await this.request("", "", JSON_MEDIA);
      const branch = stringAt(await this.json(response, ""), "default_branch");
      if (branch === null) throw new SourceError("unexpected", "", response.status);
      return branch;
    })();
    this.branch.catch(() => {
      this.branch = null;
    });
    return this.branch;
  }

  private rootTree(revision: string): Promise<string> {
    return this.cached(this.rootTrees, revision, async () => {
      const response = await this.request(`/git/commits/${revision}`, "", JSON_MEDIA);
      const sha = stringAt(await this.json(response, ""), "tree", "sha");
      if (sha === null) throw new SourceError("unexpected", "", response.status);
      return sha;
    });
  }

  private tree(sha: string, path: string): Promise<Tree> {
    return this.cached(this.trees, sha, async () => {
      const response = await this.request(`/git/trees/${sha}`, path, JSON_MEDIA);
      const tree = asTree(await this.json(response, path));
      if (tree === null) throw new SourceError("unexpected", path, response.status);
      if (tree.truncated) throw new SourceError("too-large", path, response.status);
      return tree;
    });
  }

  /** Caches a promise by key; a rejected promise is dropped so the next call retries. */
  private cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) {
    let promise = cache.get(key);
    if (promise === undefined) {
      promise = load();
      cache.set(key, promise);
      promise.catch(() => cache.delete(key));
    }
    return promise;
  }

  private async json(response: Response, path: string): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new SourceError("unexpected", path, response.status);
    }
  }

  /** One API request. Errors carry the repository path, never the URL or headers. */
  private async request(
    suffix: string,
    path: string,
    accept: string,
    validator?: string | null,
  ): Promise<Response> {
    const headers = new Headers({
      Accept: accept,
      "X-GitHub-Api-Version": API_VERSION,
    });
    if (this.config.token !== undefined && this.config.token !== null) {
      headers.set("Authorization", `Bearer ${this.config.token.reveal()}`);
    }
    if (validator !== undefined && validator !== null) headers.set("If-None-Match", validator);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.repoUrl}${suffix}`, {
        headers,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      throw new SourceError("unreachable", path);
    }
    this.recordRateLimit(response.headers);
    if (response.ok || response.status === 304) return response;
    const kind = this.errorKind(response);
    const retryAt = this.retryAt(response);
    throw new SourceError(
      kind,
      path,
      response.status,
      retryAt,
      this.errorMessage(kind, response, retryAt),
    );
  }

  private errorMessage(
    kind: SourceErrorKind,
    response: Response,
    retryAt: Date | null,
  ): string | undefined {
    if (this.config.token === undefined || this.config.token === null) {
      if (response.status === 401 || response.status === 404) {
        return "This repository needs a token or does not exist.";
      }
    }
    if (kind === "forbidden") {
      return this.config.token === undefined || this.config.token === null
        ? "Access was denied. Check that the repository is public."
        : "Access was denied. Check repository visibility or token permissions.";
    }
    if (kind === "rate-limited") {
      return retryAt === null
        ? "GitHub API rate limit reached. Try again later."
        : `GitHub API rate limit reached. Try again after ${retryAt.toLocaleString()}.`;
    }
    return undefined;
  }

  private recordRateLimit(headers: Headers): void {
    const limit = Number(headers.get("x-ratelimit-limit"));
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (headers.has("x-ratelimit-limit") && [limit, remaining, reset].every(Number.isFinite)) {
      this.lastRateLimit = { limit, remaining, resetAt: new Date(reset * 1000) };
    }
  }

  private errorKind(response: Response): SourceErrorKind {
    switch (response.status) {
      case 401:
        return "unauthorized";
      case 403:
      case 429:
        return this.isRateLimited(response) ? "rate-limited" : "forbidden";
      case 404:
        return "not-found";
      default:
        return "unexpected";
    }
  }

  private isRateLimited(response: Response): boolean {
    return (
      response.status === 429 ||
      response.headers.has("retry-after") ||
      response.headers.get("x-ratelimit-remaining") === "0"
    );
  }

  private retryAt(response: Response): Date | null {
    if (!this.isRateLimited(response) || (response.status !== 403 && response.status !== 429)) {
      return null;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    if (response.headers.has("retry-after") && Number.isFinite(retryAfter)) {
      return new Date(this.now().getTime() + retryAfter * 1000);
    }
    return this.lastRateLimit?.resetAt ?? null;
  }
}

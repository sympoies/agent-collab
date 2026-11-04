// A tiny git server over a files map, behind the GitHub provider's fetch: trees and blobs are named
// by hashes of their content, so identical content has identical ids, as in a real repository.

export const API = "https://api.example.test";
export const REPO = `${API}/repos/alice-org/collab`;

/** A tiny git server over a files map: trees and blobs are named by hashes of their content. */
export function git(files: Record<string, string>) {
  let current = files;
  let revision = 1;
  const requests: string[] = [];
  /** For each ref request: the validator it sent and the status it got. */
  const refs: { ifNoneMatch: string | null; status: number }[] = [];
  const hash = (text: string) => {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1)
      value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
    return (value >>> 0).toString(16).padStart(8, "0");
  };
  const trees = new Map<
    string,
    { path: string; type: string; sha: string; mode: string; size?: number }[]
  >();
  const blobs = new Map<string, string>();
  /** The sha of every directory and file by path, for naming expected requests. */
  const shas = new Map<string, string>();
  const build = (dir: string): string => {
    const names = new Map<string, "blob" | "tree">();
    const prefix = dir === "" ? "" : `${dir}/`;
    for (const file of Object.keys(current)) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? "blob" : "tree");
    }
    const entries = [...names].sort().map(([name, type]) => {
      const sha =
        type === "tree" ? build(`${prefix}${name}`) : hash(current[`${prefix}${name}`] ?? "");
      if (type === "blob") blobs.set(sha, current[`${prefix}${name}`] ?? "");
      shas.set(`${prefix}${name}`, sha);
      const size = new TextEncoder().encode(current[`${prefix}${name}`] ?? "").length;
      return { path: name, type, sha, mode: type === "tree" ? "040000" : "100644", size };
    });
    const sha = hash(JSON.stringify(entries));
    trees.set(sha, entries);
    shas.set(dir, sha);
    return sha;
  };
  let root = build("");
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const route = (input instanceof Request ? input.url : input.toString()).slice(REPO.length);
    requests.push(route);
    if (route.startsWith("/git/ref/heads/")) {
      const etag = `"r${String(revision)}"`;
      const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
      if (ifNoneMatch === etag) {
        refs.push({ ifNoneMatch, status: 304 });
        return Promise.resolve(new Response(null, { status: 304 }));
      }
      refs.push({ ifNoneMatch, status: 200 });
      return Promise.resolve(json({ object: { sha: `r${String(revision)}` } }, { etag }));
    }
    if (route.startsWith("/git/commits/")) return Promise.resolve(json({ tree: { sha: root } }));
    const tree = /^\/git\/trees\/(.+)$/.exec(route)?.[1];
    if (tree !== undefined)
      return Promise.resolve(json({ truncated: false, tree: trees.get(tree) }));
    const blob = /^\/git\/blobs\/(.+)$/.exec(route)?.[1];
    if (blob !== undefined) return Promise.resolve(new Response(blobs.get(blob) ?? ""));
    throw new Error(`unexpected request: ${route}`);
  };
  return {
    fetch,
    requests,
    refs,
    commit: (next: Record<string, string>) => {
      current = next;
      revision += 1;
      trees.clear();
      shas.clear();
      root = build("");
    },
    sha: (path: string) => shas.get(path) ?? "missing",
    etag: () => `"r${String(revision)}"`,
  };
}

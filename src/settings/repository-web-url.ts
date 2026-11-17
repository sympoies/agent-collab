import type { Platform } from "./model";

/** The web page for a saved GitHub repository, or null when its source cannot be linked. */
export function repositoryWebUrl(
  platform: Platform,
  endpoint: string,
  repository: string,
): string | null {
  if (platform !== "github" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    return null;
  }
  let api: URL;
  try {
    api = new URL(endpoint);
  } catch {
    return null;
  }
  if (api.protocol !== "https:" || api.username !== "" || api.password !== "") return null;
  const publicApi = api.hostname === "api.github.com";
  const webHost = publicApi ? "github.com" : api.host;
  const prefix = publicApi ? "" : api.pathname.replace(/\/api\/v3\/?$/, "").replace(/\/+$/, "");
  const path = repository.split("/").map(encodeURIComponent).join("/");
  return `https://${webHost}${prefix}/${path}`;
}

// The link that opens GitHub's fine-grained token form, prefilled. It carries only documented query
// parameters (name, description, target_name, expires_in and a permission) and never a secret.

/** The page that creates a fine-grained token, with no parameters. */
export const PLAIN_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

const DEFAULT_API = "https://api.github.com";

/**
 * The prefilled token form for this endpoint and repository, or null when the endpoint is not
 * GitHub's public API (another host has its own token page). `repository` is `owner/name` or
 * empty; `privateAccess` adds the read permission a private repository needs.
 */
export function tokenCreationUrl(options: {
  readonly endpoint: string;
  readonly repository: string;
  readonly privateAccess: boolean;
  /** The token's name and description as GitHub will show them (catalog text). */
  readonly name: string;
  readonly description: string;
}): string | null {
  if (options.endpoint !== DEFAULT_API) return null;
  const params = new URLSearchParams({
    name: options.name,
    description: options.description,
    expires_in: "30",
  });
  const [owner = ""] = options.repository.split("/");
  if (/^[A-Za-z0-9-]+$/.test(owner) && options.repository.includes("/")) {
    params.set("target_name", owner);
  }
  if (options.privateAccess) params.set("contents", "read");
  return `${PLAIN_TOKEN_URL}?${params.toString()}`;
}

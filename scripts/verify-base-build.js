import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const base = "/agent-collab/";
execFileSync("pnpm", ["build"], {
  stdio: "inherit",
  env: { ...process.env, VITE_BASE_PATH: base },
});

const html = readFileSync("dist/index.html", "utf8");
const assetUrls = [...html.matchAll(/(?:src|href)="([^\x22\s]+\/assets\/[^\x22\s]+)"/g)].map(
  ([, url]) => url,
);

assert.ok(assetUrls.length > 0, "production HTML should reference built assets");
assert.ok(
  assetUrls.every((url) => url.startsWith(`${base}assets/`)),
  `asset URLs should start with ${base}: ${assetUrls.join(", ")}`,
);
assert.match(
  html,
  /<meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; script-src &#39;self&#39;; object-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;; connect-src &#39;self&#39; https:">/,
  "the build-only CSP meta tag should remain in production HTML",
);

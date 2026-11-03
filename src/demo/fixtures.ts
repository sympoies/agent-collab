// Synthetic demo repository (fixtures/demo-repo) used by the demo build and view tests.

import marker from "../../fixtures/demo-repo/.agent-collab?raw";

const ROOT = "/fixtures/demo-repo/";

const files = import.meta.glob<string>(
  ["/fixtures/demo-repo/**/*.md", "/fixtures/demo-repo/.agent-collab"],
  { query: "?raw", import: "default", eager: true },
);

const entries: [string, string][] = Object.entries(files).map(([path, text]) => [
  path.slice(ROOT.length),
  text,
]);
entries.push([".agent-collab", marker]);

export const demoFiles: Readonly<Record<string, string>> = Object.fromEntries(entries);

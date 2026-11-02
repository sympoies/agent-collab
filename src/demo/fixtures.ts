// Synthetic demo repository (fixtures/demo-repo) used by the demo build and view tests.

const ROOT = "/fixtures/demo-repo/";

const files = import.meta.glob<string>(
  ["/fixtures/demo-repo/**/*.md", "/fixtures/demo-repo/.agent-collab"],
  { query: "?raw", import: "default", eager: true },
);

export const demoFiles: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [path.slice(ROOT.length), text]),
);

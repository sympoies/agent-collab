import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required to create the live-demo snapshot.");

const api = "https://api.github.com/repos/sympoies/agent-collab-demo";
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function request(path, accept = headers.Accept) {
  const response = await fetch(`${api}${path}`, {
    headers: { ...headers, Accept: accept },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status} while reading ${path}.`);
  }
  return response;
}

const ref = await (await request("/git/ref/heads/main")).json();
const commitSha = ref?.object?.sha;
if (typeof commitSha !== "string") throw new Error("The live-demo branch reference is invalid.");
const commit = await (await request(`/git/commits/${encodeURIComponent(commitSha)}`)).json();
const treeSha = commit?.tree?.sha;
if (typeof treeSha !== "string") throw new Error("The live-demo commit tree is invalid.");
const tree = await (await request(`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`)).json();
if (tree?.truncated === true || !Array.isArray(tree?.tree)) {
  throw new Error("The live-demo repository tree is incomplete.");
}

const entries = tree.tree
  .filter(
    (entry) =>
      entry?.type === "blob" &&
      entry.mode !== "120000" &&
      (entry.path === ".agent-collab" ||
        (entry.path.startsWith("inbox/") && entry.path.endsWith(".md")) ||
        entry.path.startsWith("topics/")) &&
      typeof entry.sha === "string" &&
      typeof entry.path === "string" &&
      (typeof entry.size !== "number" || entry.size <= 1024 * 1024),
  )
  .sort((left, right) => left.path.localeCompare(right.path));

if (!entries.some((entry) => entry.path === ".agent-collab")) {
  throw new Error("The live-demo collaboration marker is missing.");
}

const files = [];
for (const entry of entries) {
  const response = await request(
    `/git/blobs/${encodeURIComponent(entry.sha)}`,
    "application/vnd.github.raw+json",
  );
  files.push({ path: entry.path, text: await response.text() });
}

const snapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  revision: treeSha,
  files,
};
writeFileSync(resolve("public/demo-snapshot.json"), JSON.stringify(snapshot));

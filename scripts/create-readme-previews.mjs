import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = resolve(root, "docs/assets/readme");

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine a local preview-server port.");
  }
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
  return address.port;
}

function run(args, env) {
  const result = spawnSync("pnpm", args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`pnpm ${args.join(" ")} failed.`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

const artifacts = mkdtempSync(join(tmpdir(), "agent-collab-readme-previews-"));
try {
  const env = {
    ...process.env,
    PLAYWRIGHT_PORT: process.env.PLAYWRIGHT_PORT ?? String(await availablePort()),
    PLAYWRIGHT_SCREENSHOT_DIR: artifacts,
    README_PREVIEW_DIR: outputDirectory,
  };
  run(["build"], env);
  run(["exec", "playwright", "test", "e2e/readme-previews.spec.ts", "--project=chromium"], env);
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
} finally {
  rmSync(artifacts, { recursive: true, force: true });
}

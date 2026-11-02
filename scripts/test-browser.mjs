import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const screenshotDir = process.env.PLAYWRIGHT_SCREENSHOT_DIR;

if (!screenshotDir || !isAbsolute(screenshotDir)) {
  console.error("Set PLAYWRIGHT_SCREENSHOT_DIR to an absolute directory outside the repository.");
  process.exit(2);
}

const resolvedScreenshots = resolve(screenshotDir);
const fromRoot = relative(root, resolvedScreenshots);
const outsideRepository = fromRoot === ".." || fromRoot.startsWith(`..${sep}`);
if (!outsideRepository) {
  console.error("PLAYWRIGHT_SCREENSHOT_DIR must be outside the repository.");
  process.exit(2);
}

mkdirSync(resolvedScreenshots, { recursive: true });
for (const args of [["build"], ["exec", "playwright", "test"]]) {
  const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderNginxConfig } from "../docker/render-nginx-config.mjs";

const repository = process.cwd();

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repository, path), "utf8");
}

describe("static image delivery", () => {
  it("uses SPA fallback and exposes an unauthenticated health endpoint", () => {
    const serverConfig = renderNginxConfig("/viewer/");

    expect(serverConfig).toMatch(/location\s+\^~\s+\/viewer\//);
    expect(serverConfig).toMatch(/rewrite\s+\^\/viewer\/\(\.\*\)\$\s+\/\$1\s+break/);
    expect(serverConfig).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html/);
    expect(serverConfig).toMatch(/location\s*=\s*\/healthz/);
    expect(serverConfig).toMatch(/return\s+200/);
    expect(renderNginxConfig("/")).not.toMatch(/__BASE_PATH_LOCATION__/);
    expect(() => renderNginxConfig("/viewer; include /etc/passwd/")).toThrow(/VITE_BASE_PATH/);
  });

  it("keeps credentials and local state out of the Docker build context", () => {
    const dockerIgnore = readRepositoryFile(".dockerignore");

    for (const pattern of [".git", "node_modules", ".env", ".env.*", ".npmrc", "*.pem", "*.key"]) {
      expect(dockerIgnore.split(/\r?\n/)).toContain(pattern);
    }
    expect(dockerIgnore.split(/\r?\n/)).not.toContain("public/demo-snapshot.json");
  });

  it("builds from the lockfile and pins both container base images", () => {
    const dockerfile = readRepositoryFile("Dockerfile");

    expect(dockerfile).toMatch(/pnpm install --frozen-lockfile/);
    expect(dockerfile).toMatch(/^FROM node:24-alpine@sha256:[a-f0-9]{64} AS build/m);
    expect(dockerfile).toMatch(
      /^FROM nginxinc\/nginx-unprivileged:1\.29-alpine@sha256:[a-f0-9]{64}$/m,
    );
    expect(dockerfile).toMatch(/^COPY \. \.$/m);
  });

  it("keeps the Compose service opt-in and independent of the agent runtime", () => {
    const compose = readRepositoryFile("compose.yaml");

    expect(compose).toMatch(/profiles:\s*\[static-viewer\]/);
    expect(compose).toMatch(/healthcheck:/);
    expect(compose).not.toMatch(/volumes:/);
    expect(compose).not.toMatch(/nils-cli|agent-runtime-kit|workspace/i);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/release-image.yml"),
  "utf8",
);

/** The text of one top-level job, from its key to the next job (or the end of the file). */
function job(name: string): string {
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  const match = jobs.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`));
  if (!match?.[1]) throw new Error(`job ${name} not found`);
  return match[1];
}

describe("release image workflow", () => {
  it("runs on version tags and on an explicit manual version only", () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}tags: \["v\*"\]\n {2}workflow_dispatch:/m);
    expect(workflow).not.toMatch(/branches:|pull_request|schedule:/);
    expect(workflow).toMatch(/inputs:\n {6}version:\n(?: {8}.*\n)*? {8}required: true/);
  });

  it("grants nothing by default and packages: write only to the publish job", () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow.match(/packages: write/g)).toHaveLength(1);
    expect(job("publish")).toMatch(/packages: write/);
    expect(job("smoke")).not.toMatch(/write/);
    expect(job("publish")).not.toMatch(/(contents|id-token|actions): write/);
  });

  it("pins every action by commit SHA with a version comment and uses no other secret", () => {
    const uses = workflow.match(/^\s+(?:- )?uses: .*$/gm) ?? [];

    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[a-f0-9]{40} # v\d+\.\d+\.\d+$/);
    }
    const secrets = workflow.match(/secrets\.[A-Za-z_]+/g) ?? [];
    expect(secrets.length).toBeGreaterThan(0);
    expect(new Set(secrets)).toEqual(new Set(["secrets.GITHUB_TOKEN"]));
  });

  it("smoke-tests each platform without credentials before anything is pushed", () => {
    const smoke = job("smoke");
    const publish = job("publish");

    expect(smoke).toMatch(/linux\/amd64/);
    expect(smoke).toMatch(/linux\/arm64/);
    expect(smoke).toMatch(/load: true/);
    expect(smoke).toMatch(/scripts\/verify-static-image\.sh/);
    expect(smoke).not.toMatch(/push: true|login-action|ghcr\.io/);
    expect(publish).toMatch(/needs: smoke/);
  });

  it("publishes a multi-platform image under the version tag only, and records its digest", () => {
    const publish = job("publish");

    expect(publish).toMatch(/platforms: linux\/amd64,linux\/arm64/);
    expect(publish).toMatch(/push: true/);
    expect(publish).toMatch(
      /ghcr\.io\/sympoies\/agent-collab-viewer:\$\{\{ steps\.version\.outputs\.value \}\}/,
    );
    expect(workflow).not.toMatch(/:latest|latest=true/);
    expect(publish).toMatch(/org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/);
    expect(publish).toMatch(/steps\.build\.outputs\.digest/);
    expect(publish).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(publish).toMatch(/upload-artifact@/);
  });

  it("validates the version and refuses to overwrite a published one", () => {
    const publish = job("publish");

    expect(publish).toMatch(/\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/);
    expect(publish).toMatch(/imagetools inspect/);
    // Inputs reach the shell through env, never through inline expression interpolation.
    expect(workflow).not.toMatch(/run: .*\$\{\{ (inputs|github\.ref_name)/);
  });
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** The body of every `run:` step (single-line or block) as one string per step. */
function runBodies(text: string): string[] {
  const lines = text.split("\n");
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    const body = [match[2] ?? ""];
    while (i + 1 < lines.length) {
      const next = lines[i + 1] ?? "";
      if (next.trim() !== "" && next.length - next.trimStart().length <= indent) break;
      body.push(next);
      i += 1;
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
}

/** Runs the version-resolving step the way the workflow does and returns its result. */
function resolveVersion(eventName: string, inputVersion: string, refName: string) {
  const step = job("version").match(/ {8}run: \|\n((?: {10}.*\n?)+)/)?.[1];
  if (!step) throw new Error("version step not found");
  const dir = mkdtempSync(join(tmpdir(), "release-version-"));
  const output = join(dir, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-e", "-c", step.replace(/^ {10}/gm, "")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      EVENT_NAME: eventName,
      INPUT_VERSION: inputVersion,
      REF_NAME: refName,
      GITHUB_OUTPUT: output,
    },
  });
  return { status: result.status, output: readFileSync(output, "utf8") };
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
    expect(publish).toMatch(/needs: \[version, smoke\]/);
  });

  it("publishes a multi-platform image under the version tag only, and records its digest", () => {
    const publish = job("publish");

    expect(publish).toMatch(/platforms: linux\/amd64,linux\/arm64/);
    expect(publish).toMatch(/push: true/);
    expect(publish).toMatch(
      /ghcr\.io\/sympoies\/agent-collab-viewer:\$\{\{ needs\.version\.outputs\.value \}\}/,
    );
    expect(workflow).not.toMatch(/:latest|latest=true/);
    expect(publish).toMatch(/org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/);
    expect(publish).toMatch(/steps\.build\.outputs\.digest/);
    expect(publish).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(publish).toMatch(/upload-artifact@/);
  });

  it("accepts a release version from a tag or an explicit input", () => {
    expect(resolveVersion("push", "", "v1.2.3")).toEqual({ status: 0, output: "value=1.2.3\n" });
    expect(resolveVersion("workflow_dispatch", "2.0.0-rc.1", "main")).toEqual({
      status: 0,
      output: "value=2.0.0-rc.1\n",
    });
  });

  it("rejects anything that is not exactly one semantic version, including multi-line input", () => {
    const rejected = [
      "1.2.3\nvalue=latest",
      "latest",
      "1.2",
      "v1.2.3",
      "1.2.3 ",
      "1.2.3\n",
      "",
      "1.2.3/../x",
    ];

    for (const version of rejected) {
      const result = resolveVersion("workflow_dispatch", version, "main");
      expect(result, JSON.stringify(version)).toEqual({ status: 1, output: "" });
    }
    expect(resolveVersion("push", "", "vlatest")).toEqual({ status: 1, output: "" });
  });

  it("refuses to overwrite a published version, one publish per version at a time", () => {
    const publish = job("publish");

    expect(publish).toMatch(/imagetools inspect/);
    expect(publish).toMatch(
      /concurrency:\n {6}group: release-image-\$\{\{ needs\.version\.outputs\.value \}\}\n {6}cancel-in-progress: false/,
    );
  });

  it("passes inputs to shell steps only through env, never by expression inside a script", () => {
    for (const body of runBodies(workflow)) {
      expect(body).not.toContain("${{");
    }
    // The check itself must catch a block that pastes an input into the script.
    const pasted = "      - run: |\n          echo value=${{ inputs.version }}\n";
    expect(runBodies(pasted).some((body) => body.includes("${{"))).toBe(true);
    expect(
      runBodies("      - run: echo ${{ github.ref_name }}").some((b) => b.includes("${{")),
    ).toBe(true);
  });
});

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "scripts/verify-static-image.sh");

function run(...args: string[]) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8" });
}

describe("verify-static-image.sh arguments", () => {
  it("prints usage and fails without an image reference", () => {
    const result = run();

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: verify-static-image\.sh <image-ref> \[base-path\]/);
  });

  it("rejects a base path the image build would reject", () => {
    for (const basePath of ["viewer", "/viewer", "/a b/", "/x;y/"]) {
      const result = run("example.invalid/viewer:none", basePath);

      expect(result.status, basePath).toBe(2);
      expect(result.stderr).toMatch(/base path/);
    }
  });
});

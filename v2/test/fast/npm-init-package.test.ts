import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const V2_DIR = resolve(HERE, "../..");
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("npm package update helper", () => {
  it("ships the extended daemon readiness window", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "spur-npm-init-package-"));
    cleanupPaths.push(outputDir);
    const tarballName = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", outputDir],
      {
        cwd: V2_DIR,
        encoding: "utf8",
        env: { ...process.env, npm_config_loglevel: "silent" },
      },
    )
      .trim()
      .split("\n")
      .at(-1);
    if (!tarballName) throw new Error("npm pack returned no tarball name");

    const packagedHelper = execFileSync(
      "tar",
      ["-xOf", join(outputDir, tarballName), "package/scripts/npm-init.sh"],
      { encoding: "utf8" },
    );

    expect(packagedHelper).toContain("for _ in $(seq 1 60); do");
    expect(packagedHelper).not.toContain("for _ in $(seq 1 10); do");
  });
});

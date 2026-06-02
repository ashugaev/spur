import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { assertBranchAllowed, matchesCliEntrypoint } from "../../src/cli.js";

describe("cli entrypoint", () => {
  it("matches when argv[1] is a symlink to the real CLI path", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "spur-cli-entrypoint-"));
    const targetPath = join(fixtureDir, "cli.js");
    const symlinkPath = join(fixtureDir, "spur");

    writeFileSync(targetPath, "#!/usr/bin/env node\n");
    symlinkSync(targetPath, symlinkPath);

    expect(matchesCliEntrypoint(pathToFileURL(targetPath).href, symlinkPath)).toBe(true);
  });

  it("does not match an unrelated argv path", () => {
    expect(matchesCliEntrypoint(pathToFileURL("/tmp/real-cli.js").href, "/tmp/other-cli.js")).toBe(
      false,
    );
  });

  it("checks branch naming against registered project configs", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "spur-cli-branch-"));
    const dataDir = join(fixtureDir, "data");
    const projectDir = join(fixtureDir, "repo");
    mkdirSync(dataDir);
    mkdirSync(projectDir);
    const instanceConfigPath = join(fixtureDir, "config.yaml");
    const projectConfigPath = join(fixtureDir, "spur.yaml");
    writeFileSync(
      instanceConfigPath,
      `
dataDir: ${dataDir}
projects: {}
`,
    );
    writeFileSync(
      projectConfigPath,
      `
projects:
  sp:
    path: ${projectDir}
    branchNaming:
      regex: "^feature/[a-z]+(-[a-z]+){0,3}$"
`,
    );
    writeFileSync(
      join(dataDir, "config-registry.json"),
      JSON.stringify({ configPaths: [projectConfigPath], unconfiguredProjects: [] }),
    );

    expect(() =>
      assertBranchAllowed(instanceConfigPath, "sp", "feature/branch-name"),
    ).not.toThrow();
    expect(() => assertBranchAllowed(instanceConfigPath, "sp", "bad-name")).toThrow(
      'branch "bad-name" must match ^feature/[a-z]+(-[a-z]+){0,3}$',
    );
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIsolatedProjectConfig,
  projectUsesCurrentRepository,
} from "../../src/isolated-project-config.js";

function createRepo(prefix: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Spur Test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "spur@example.com"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("isolated project config", () => {
  it("matches projects that use the current repository", () => {
    const repoDir = createRepo("spur-isolated-project-config-");
    cleanupPaths.push(repoDir);

    expect(projectUsesCurrentRepository(repoDir, repoDir)).toBe(true);

    const otherRepoDir = createRepo("spur-isolated-project-config-other-");
    cleanupPaths.push(otherRepoDir);
    expect(projectUsesCurrentRepository(repoDir, otherRepoDir)).toBe(false);
  });

  it("rewrites matching projects to the current worktree and shared symlinks", () => {
    const repoDir = createRepo("spur-isolated-project-config-");
    cleanupPaths.push(repoDir);

    const output = buildIsolatedProjectConfig(
      `projects:
  api:
    path: ${repoDir}
    defaultBranch: main
    branchNaming:
      regex: "^feature/[a-z]+$"
    symlinks:
      - .env
  other:
    path: /tmp/not-this-repo
    defaultBranch: release
`,
      repoDir,
      "feature/current-worktree",
    );

    const parsed = parseYaml(output) as {
      projects: Record<
        string,
        {
          path: string;
          defaultBranch: string;
          branchNaming?: { regex: string };
          symlinks?: string[];
        }
      >;
    };

    const apiProject = parsed.projects.api;
    const otherProject = parsed.projects.other;

    expect(apiProject).toBeDefined();
    expect(otherProject).toBeDefined();
    if (!apiProject || !otherProject) {
      throw new Error("expected parsed projects");
    }

    expect(apiProject.path).toBe(repoDir);
    expect(apiProject.defaultBranch).toBe("feature/current-worktree");
    expect(apiProject.branchNaming).toEqual({ regex: "^feature/[a-z]+$" });
    expect(apiProject.symlinks).toEqual([
      ".env",
      "spur.yaml",
      "spur.yml",
      "AGENTS.md",
      "CLAUDE.md",
      ".agents",
      ".claude",
    ]);

    expect(otherProject.path).toBe("/tmp/not-this-repo");
    expect(otherProject.defaultBranch).toBe("release");
  });
});

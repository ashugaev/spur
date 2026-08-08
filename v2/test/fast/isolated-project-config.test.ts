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

  it("strips listener fields from every project while preserving other config", () => {
    const repoDir = createRepo("spur-isolated-project-config-");
    cleanupPaths.push(repoDir);

    const output = buildIsolatedProjectConfig(
      `projects:
  api:
    path: ${repoDir}
    defaultBranch: main
    symlinks:
      - .env
    sources:
      - github
    triggers:
      - gh-pr-review-spawn
    mcp:
      servers:
        - local
    env:
      FOO: bar
  other:
    path: /tmp/not-this-repo
    defaultBranch: release
    sources:
      - github
    triggers:
      - gh-pr-review-spawn
    env:
      BAZ: qux
`,
      repoDir,
      "feature/current-worktree",
    );

    const parsed = parseYaml(output) as {
      projects: Record<string, Record<string, unknown>>;
    };

    const apiProject = parsed.projects.api;
    const otherProject = parsed.projects.other;
    if (!apiProject || !otherProject) {
      throw new Error("expected parsed projects");
    }

    // current-repo: listeners removed, overrides still applied, other fields kept
    expect(apiProject.sources).toBeUndefined();
    expect(apiProject.triggers).toBeUndefined();
    expect(apiProject.path).toBe(repoDir);
    expect(apiProject.defaultBranch).toBe("feature/current-worktree");
    expect(apiProject.symlinks).toEqual([
      ".env",
      "spur.yaml",
      "spur.yml",
      "AGENTS.md",
      "CLAUDE.md",
      ".agents",
      ".claude",
    ]);
    expect(apiProject.mcp).toEqual({ servers: ["local"] });
    expect(apiProject.env).toEqual({ FOO: "bar" });

    // non-current-repo: listeners removed, nothing else rewritten
    expect(otherProject.sources).toBeUndefined();
    expect(otherProject.triggers).toBeUndefined();
    expect(otherProject.path).toBe("/tmp/not-this-repo");
    expect(otherProject.defaultBranch).toBe("release");
    expect(otherProject.env).toEqual({ BAZ: "qux" });
    expect(otherProject.symlinks).toBeUndefined();
  });

  it("leaves projects without listener fields unaffected", () => {
    const repoDir = createRepo("spur-isolated-project-config-");
    cleanupPaths.push(repoDir);

    const output = buildIsolatedProjectConfig(
      `projects:
  other:
    path: /tmp/not-this-repo
    defaultBranch: release
`,
      repoDir,
      "feature/current-worktree",
    );

    const parsed = parseYaml(output) as {
      projects: Record<string, Record<string, unknown>>;
    };

    const otherProject = parsed.projects.other;
    if (!otherProject) {
      throw new Error("expected parsed project");
    }

    expect(otherProject.path).toBe("/tmp/not-this-repo");
    expect(otherProject.defaultBranch).toBe("release");
    expect(otherProject.sources).toBeUndefined();
    expect(otherProject.triggers).toBeUndefined();
  });
});

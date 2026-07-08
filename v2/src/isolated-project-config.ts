import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const ISOLATED_WORKTREE_SYMLINKS = [
  ".env",
  "spur.yaml",
  "spur.yml",
  "AGENTS.md",
  "CLAUDE.md",
  ".agents",
  ".claude",
] as const;

interface RawProjectConfig {
  path?: unknown;
  defaultBranch?: unknown;
  symlinks?: unknown;
  [key: string]: unknown;
}

// `sources` and `triggers` drive the parent orchestrator's listeners. An
// isolated/sidecar subagent daemon must not inherit them, or it re-fires the
// parent's triggers (e.g. a /code-review subagent re-spawning
// gh-pr-review-spawn). Drop them from every project in the isolated config.
function stripSidecarExcludedFields(project: RawProjectConfig): RawProjectConfig {
  const { sources: _sources, triggers: _triggers, ...rest } = project;
  return rest;
}

interface RawProjectConfigDocument {
  projects?: Record<string, RawProjectConfig>;
  [key: string]: unknown;
}

function gitCommonDir(path: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: path,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function normalizeSymlinks(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      ),
    ),
  ];
}

function isProjectConfigDocument(value: unknown): value is RawProjectConfigDocument {
  return typeof value === "object" && value !== null;
}

export function projectUsesCurrentRepository(
  currentWorktreePath: string,
  projectPath: unknown,
): boolean {
  if (typeof projectPath !== "string" || !projectPath.trim()) {
    return false;
  }
  const currentRepo = gitCommonDir(currentWorktreePath);
  const projectRepo = gitCommonDir(projectPath);
  return currentRepo !== null && currentRepo === projectRepo;
}

export function buildIsolatedProjectConfig(
  sourceConfig: string,
  currentWorktreePath: string,
  currentBranch?: string,
): string {
  const parsed = parseYaml(sourceConfig) as unknown;
  if (!isProjectConfigDocument(parsed) || !parsed.projects) {
    throw new Error("Project config must define projects");
  }

  const nextProjects = Object.fromEntries(
    Object.entries(parsed.projects).map(([projectId, project]) => {
      const strippedProject = stripSidecarExcludedFields(project);
      if (!projectUsesCurrentRepository(currentWorktreePath, project.path)) {
        return [projectId, strippedProject];
      }

      const symlinks = [...normalizeSymlinks(project.symlinks), ...ISOLATED_WORKTREE_SYMLINKS];

      return [
        projectId,
        {
          ...strippedProject,
          path: resolve(currentWorktreePath),
          ...(currentBranch ? { defaultBranch: currentBranch } : {}),
          symlinks: [...new Set(symlinks)],
        },
      ];
    }),
  );

  return stringifyYaml({ ...parsed, projects: nextProjects });
}

export function writeIsolatedProjectConfig(args: {
  inputPath: string;
  outputPath: string;
  currentWorktreePath: string;
  currentBranch?: string;
}): void {
  const sourceConfig = readFileSync(args.inputPath, "utf8");
  const output = buildIsolatedProjectConfig(
    sourceConfig,
    args.currentWorktreePath,
    args.currentBranch,
  );
  writeFileSync(args.outputPath, output, "utf8");
}

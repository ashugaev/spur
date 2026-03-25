import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMergedConfig, writeConfigRegistry } from "../../src/registry.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

async function writeConfig(
  rootDir: string,
  name: string,
  body: string,
): Promise<string> {
  const path = join(rootDir, name);
  await writeFile(path, body, "utf8");
  return path;
}

function configYaml(args: {
  port: number;
  dataDir: string;
  worktreeDir: string;
  projectId: string;
  projectPath: string;
  sessionPrefix: string;
  defaultAgent?: "claude" | "codex";
}): string {
  return `server:
  host: 127.0.0.1
  port: ${args.port}
dataDir: ${args.dataDir}
worktreeDir: ${args.worktreeDir}
${args.defaultAgent ? `defaultAgent: ${args.defaultAgent}\n` : ""}projects:
  ${args.projectId}:
    path: ${args.projectPath}
    defaultBranch: main
    sessionPrefix: ${args.sessionPrefix}
`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("registry.buildMergedConfig", () => {
  it("merges registered configs into one daemon project set", async () => {
    const rootDir = await createTempDir("spur-registry-fast-");
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");

    const basePath = await writeConfig(
      rootDir,
      "base.yaml",
      configYaml({
        port: 4310,
        dataDir,
        worktreeDir,
        projectId: "api",
        projectPath: join(rootDir, "repo-a"),
        sessionPrefix: "api",
      }),
    );
    const extraPath = await writeConfig(
      rootDir,
      "extra.yaml",
      configYaml({
        port: 4310,
        dataDir,
        worktreeDir,
        projectId: "web",
        projectPath: join(rootDir, "repo-b"),
        sessionPrefix: "web",
        defaultAgent: "codex",
      }),
    );

    writeConfigRegistry(dataDir, [basePath, extraPath]);

    const merged = buildMergedConfig(basePath, [basePath, extraPath]);

    expect(Object.keys(merged.config.projects)).toEqual(["api", "web"]);
    expect(merged.config.projects.api?.defaultAgent).toBe("claude");
    expect(merged.config.projects.web?.defaultAgent).toBe("codex");
  });

  it("rejects duplicate project ids across registered configs", async () => {
    const rootDir = await createTempDir("spur-registry-dup-");
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");

    const basePath = await writeConfig(
      rootDir,
      "base.yaml",
      configYaml({
        port: 4310,
        dataDir,
        worktreeDir,
        projectId: "api",
        projectPath: join(rootDir, "repo-a"),
        sessionPrefix: "api-a",
      }),
    );
    const extraPath = await writeConfig(
      rootDir,
      "extra.yaml",
      configYaml({
        port: 4310,
        dataDir,
        worktreeDir,
        projectId: "api",
        projectPath: join(rootDir, "repo-b"),
        sessionPrefix: "api-b",
      }),
    );

    expect(() => buildMergedConfig(basePath, [basePath, extraPath])).toThrow(
      'Project "api" is duplicated',
    );
  });
});

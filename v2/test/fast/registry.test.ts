import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeConfigPaths,
  addUnconfiguredProject,
  buildMergedConfig,
  isInsideWorktreeDir,
  mutateConfigRegistry,
  readConfigRegistryFile,
  removeConfigRegistryPath,
  removeUnconfiguredProject,
  writeConfigRegistry,
  writeConfigRegistryFile,
  type UnconfiguredProjectEntry,
} from "../../src/registry.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

async function writeConfig(rootDir: string, name: string, body: string): Promise<string> {
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
  instanceDefaultAgent?: "claude" | "codex";
  projectDefaultAgent?: "claude" | "codex";
}): string {
  return `server:
  host: 127.0.0.1
  port: ${args.port}
dataDir: ${args.dataDir}
worktreeDir: ${args.worktreeDir}
${args.instanceDefaultAgent ? `defaultAgent: ${args.instanceDefaultAgent}\n` : ""}projects:
  ${args.projectId}:
    path: ${args.projectPath}
    defaultBranch: main
    sessionPrefix: ${args.sessionPrefix}
${args.projectDefaultAgent ? `    defaultAgent: ${args.projectDefaultAgent}\n` : ""}`;
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
        projectDefaultAgent: "codex",
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

  it("skips duplicate registered configs when skipInvalid is enabled", async () => {
    const rootDir = await createTempDir("spur-registry-skip-dup-");
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");
    const warnings: string[] = [];

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
    const duplicatePath = await writeConfig(
      rootDir,
      "duplicate.yaml",
      configYaml({
        port: 4310,
        dataDir,
        worktreeDir,
        projectId: "api",
        projectPath: join(rootDir, "repo-b"),
        sessionPrefix: "api-copy",
      }),
    );

    const merged = buildMergedConfig(basePath, [basePath, duplicatePath], {
      skipInvalid: true,
      warn: (message) => warnings.push(message),
    });

    expect(Object.keys(merged.config.projects)).toEqual(["api"]);
    expect(warnings).toEqual([
      expect.stringContaining(`Skipping registered config ${duplicatePath}`),
    ]);
  });
});

describe("registry.activeConfigPaths", () => {
  it("drops a missing file and a directory entry while readConfigRegistryFile returns the raw list", async () => {
    const rootDir = await createTempDir("spur-registry-active-");
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const worktreeDir = join(rootDir, "worktrees");

    const existingPath = await writeConfig(rootDir, "exists.yaml", "stub: true\n");
    const missingPath = join(rootDir, "missing.yaml");
    const directoryPath = join(rootDir, "a-directory");
    mkdirSync(directoryPath, { recursive: true });

    writeConfigRegistry(dataDir, [existingPath, missingPath, directoryPath]);

    const raw = readConfigRegistryFile(dataDir).configPaths;
    expect(raw).toEqual([existingPath, missingPath, directoryPath]);

    expect(activeConfigPaths(raw, worktreeDir)).toEqual([existingPath]);
  });

  it("refuses to register a config path inside worktreeDir", async () => {
    const rootDir = await createTempDir("spur-registry-worktree-guard-");
    tempDirs.push(rootDir);
    const worktreeDir = join(rootDir, "worktrees");
    const worktreeConfigPath = join(worktreeDir, "proj", "sess", "spur.yaml");
    mkdirSync(join(worktreeDir, "proj", "sess"), { recursive: true });
    await writeFile(worktreeConfigPath, "stub: true\n", "utf8");

    expect(isInsideWorktreeDir(worktreeConfigPath, worktreeDir)).toBe(true);
    expect(activeConfigPaths([worktreeConfigPath], worktreeDir)).toEqual([]);
  });

  it("dedupes entries that resolve to the same realpath", async () => {
    const rootDir = await createTempDir("spur-registry-dedupe-");
    tempDirs.push(rootDir);
    const worktreeDir = join(rootDir, "worktrees");
    const existingPath = await writeConfig(rootDir, "exists.yaml", "stub: true\n");
    const nonCanonicalForm = join(rootDir, ".", "exists.yaml");

    expect(activeConfigPaths([existingPath, nonCanonicalForm], worktreeDir)).toEqual([
      existingPath,
    ]);
  });
});

describe("registry.isInsideWorktreeDir", () => {
  it("rejects a sibling path sharing the worktreeDir prefix", async () => {
    const rootDir = await createTempDir("spur-registry-prefix-sibling-");
    tempDirs.push(rootDir);
    const worktreeDir = join(rootDir, "worktrees");
    const siblingConfigPath = join(`${worktreeDir}-backup`, "spur.yaml");

    expect(isInsideWorktreeDir(siblingConfigPath, worktreeDir)).toBe(false);
  });
});

describe("registry.removeConfigRegistryPath", () => {
  it("removes an entry addressed by a non-canonical path", async () => {
    const rootDir = await createTempDir("spur-registry-remove-noncanonical-");
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const registeredPath = await writeConfig(rootDir, "exists.yaml", "stub: true\n");

    writeConfigRegistry(dataDir, [registeredPath]);

    const nonCanonicalForm = join(rootDir, ".", "exists.yaml");
    const result = removeConfigRegistryPath(dataDir, nonCanonicalForm);

    expect(result).toEqual([]);
  });
});

describe("registry unconfiguredProjects", () => {
  it("reads legacy registry files without unconfiguredProjects and defaults to []", async () => {
    const rootDir = await createTempDir("spur-registry-legacy-");
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    mkdirSync(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "config-registry.json"),
      JSON.stringify({ configPaths: ["/tmp/spur.yaml"] }),
      "utf8",
    );

    const file = readConfigRegistryFile(dataDir);
    expect(file.configPaths).toEqual(["/tmp/spur.yaml"]);
    expect(file.unconfiguredProjects).toEqual([]);
  });

  it("round-trips unconfigured projects through add/remove", async () => {
    const rootDir = await createTempDir("spur-registry-stubs-");
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");

    const entry: UnconfiguredProjectEntry = {
      id: "demo",
      displayName: "Demo",
      prefix: "demo",
      path: "/tmp/demo",
    };
    addUnconfiguredProject(dataDir, entry);
    let file = readConfigRegistryFile(dataDir);
    expect(file.unconfiguredProjects).toEqual([entry]);

    removeUnconfiguredProject(dataDir, "demo");
    file = readConfigRegistryFile(dataDir);
    expect(file.unconfiguredProjects).toEqual([]);
  });

  it("mutateConfigRegistry writes a single normalized file", async () => {
    const rootDir = await createTempDir("spur-registry-mutate-");
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");

    writeConfigRegistryFile(dataDir, {
      configPaths: ["/tmp/a.yaml"],
      unconfiguredProjects: [{ id: "stub1", prefix: "stub1", path: "/tmp/stub1" }],
    });

    const result = mutateConfigRegistry(dataDir, (current) => ({
      configPaths: [...current.configPaths, "/tmp/b.yaml"],
      unconfiguredProjects: current.unconfiguredProjects.filter((entry) => entry.id !== "stub1"),
    }));

    expect(result.configPaths).toEqual(["/tmp/a.yaml", "/tmp/b.yaml"]);
    expect(result.unconfiguredProjects).toEqual([]);

    const onDisk = JSON.parse(
      await readFile(join(dataDir, "config-registry.json"), "utf8"),
    ) as unknown;
    expect(onDisk).toEqual({
      configPaths: ["/tmp/a.yaml", "/tmp/b.yaml"],
      unconfiguredProjects: [],
    });
  });
});

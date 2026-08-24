import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, realpathSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addUnconfiguredProject,
  buildMergedConfig,
  ConfigRegistryScanner,
  dropWorktreeInternalPaths,
  isInsideWorktreeDir,
  mutateConfigRegistry,
  readConfigRegistryFile,
  removeConfigRegistryPath,
  removeUnconfiguredProject,
  resolveRegisteredDataDirs,
  writeConfigRegistry,
  writeConfigRegistryFile,
  type RegistryDiagnostic,
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

describe("registry.dropWorktreeInternalPaths", () => {
  it("refuses to register a config path inside worktreeDir", async () => {
    const rootDir = await createTempDir("spur-registry-worktree-guard-");
    tempDirs.push(rootDir);
    const worktreeDir = join(rootDir, "worktrees");
    const worktreeConfigPath = join(worktreeDir, "proj", "sess", "spur.yaml");
    mkdirSync(join(worktreeDir, "proj", "sess"), { recursive: true });
    await writeFile(worktreeConfigPath, "stub: true\n", "utf8");

    expect(isInsideWorktreeDir(worktreeConfigPath, worktreeDir)).toBe(true);
    expect(dropWorktreeInternalPaths([worktreeConfigPath], worktreeDir)).toEqual([]);
  });

  it("keeps a path outside worktreeDir untouched, dead or alive — pruning is the scanner's job", async () => {
    const rootDir = await createTempDir("spur-registry-worktree-guard-keep-");
    tempDirs.push(rootDir);
    const worktreeDir = join(rootDir, "worktrees");
    const existingPath = await writeConfig(rootDir, "exists.yaml", "stub: true\n");
    const missingPath = join(rootDir, "missing.yaml");

    expect(dropWorktreeInternalPaths([existingPath, missingPath], worktreeDir)).toEqual([
      existingPath,
      missingPath,
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

async function setupScannerFixture(rootDir: string): Promise<{
  dataDir: string;
  worktreeDir: string;
  basePath: string;
  livePath: string;
  duplicatePath: string;
  missingParentAlivePath: string;
  orphanPath: string;
}> {
  const dataDir = join(rootDir, "data");
  const worktreeDir = join(rootDir, "worktrees");

  const basePath = await writeConfig(
    rootDir,
    "base.yaml",
    configYaml({
      port: 4310,
      dataDir,
      worktreeDir,
      projectId: "base",
      projectPath: join(rootDir, "repo-base"),
      sessionPrefix: "base",
    }),
  );
  const livePath = await writeConfig(
    rootDir,
    "live.yaml",
    configYaml({
      port: 4310,
      dataDir,
      worktreeDir,
      projectId: "live",
      projectPath: join(rootDir, "repo-live"),
      sessionPrefix: "live",
    }),
  );
  const duplicatePath = await writeConfig(
    rootDir,
    "duplicate.yaml",
    configYaml({
      port: 4310,
      dataDir,
      worktreeDir,
      projectId: "base",
      projectPath: join(rootDir, "repo-dup"),
      sessionPrefix: "base-dup",
    }),
  );
  const missingParentAlivePath = join(rootDir, "missing-alive.yaml");

  const orphanDir = join(rootDir, "orphan-dir");
  mkdirSync(orphanDir, { recursive: true });
  const orphanPath = await writeConfig(
    orphanDir,
    "orphan.yaml",
    configYaml({
      port: 4310,
      dataDir,
      worktreeDir,
      projectId: "orphan",
      projectPath: join(rootDir, "repo-orphan"),
      sessionPrefix: "orphan",
    }),
  );
  await rm(orphanDir, { recursive: true, force: true });

  return {
    dataDir,
    worktreeDir,
    basePath,
    livePath,
    duplicatePath,
    missingParentAlivePath,
    orphanPath,
  };
}

describe("registry.ConfigRegistryScanner", () => {
  it("collapses path aliases into one persisted, protected, warning identity", async () => {
    const rootDir = await createTempDir("spur-scanner-alias-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const aliasDir = join(rootDir, "alias");
    symlinkSync(rootDir, aliasDir, "dir");
    const baseAlias = join(aliasDir, "base.yaml");
    const duplicateAlias = join(aliasDir, "duplicate.yaml");
    const scanner = new ConfigRegistryScanner();

    const result = scanner.scan({
      bootstrapConfigPath: baseAlias,
      configPaths: [baseAlias, fixture.basePath, duplicateAlias, fixture.duplicatePath],
      protectedPaths: [baseAlias],
    });

    expect(result.configPaths).toEqual([
      realpathSync(fixture.basePath),
      realpathSync(fixture.duplicatePath),
    ]);
    expect(result.newDiagnostics).toHaveLength(1);
    expect(result.newDiagnostics[0]?.configPath).toBe(realpathSync(fixture.duplicatePath));
  });

  it("prunes an orphaned path, keeps a parent-alive missing path and the instance config", async () => {
    const rootDir = await createTempDir("spur-scanner-prune-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const scanner = new ConfigRegistryScanner();

    const result = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths: [
        fixture.basePath,
        fixture.livePath,
        fixture.duplicatePath,
        fixture.missingParentAlivePath,
        fixture.orphanPath,
      ],
      protectedPaths: [fixture.basePath],
    });

    expect(result.configPaths).toContain(fixture.basePath);
    expect(result.configPaths).toContain(fixture.livePath);
    expect(result.configPaths).toContain(fixture.missingParentAlivePath);
    expect(result.configPaths).not.toContain(fixture.orphanPath);
    expect(Object.keys(result.config.projects).sort()).toEqual(["base", "live"]);
  });

  it("prunes a registered project directory, keeping the real spur config file", async () => {
    const rootDir = await createTempDir("spur-scanner-directory-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const projectDir = join(rootDir, "repo-live");
    mkdirSync(projectDir, { recursive: true });
    const scanner = new ConfigRegistryScanner();

    const result = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths: [fixture.basePath, projectDir, fixture.livePath],
      protectedPaths: [fixture.basePath],
    });

    expect(result.configPaths).toEqual([fixture.basePath, fixture.livePath]);
    expect(Object.keys(result.config.projects).sort()).toEqual(["base", "live"]);
  });

  it("forgets pruned canonical paths before an orphan becomes a symlink", async () => {
    const rootDir = await createTempDir("spur-scanner-pruned-alias-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const mountDir = join(rootDir, "mount");
    const rawAlias = join(mountDir, "spur.yaml");
    const targetDir = join(rootDir, "target");
    mkdirSync(targetDir);
    const targetPath = await writeConfig(
      targetDir,
      "spur.yaml",
      configYaml({
        port: 4310,
        dataDir: fixture.dataDir,
        worktreeDir: fixture.worktreeDir,
        projectId: "target",
        projectPath: join(rootDir, "repo-target"),
        sessionPrefix: "target",
      }),
    );
    const scanner = new ConfigRegistryScanner();

    const pruned = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths: [fixture.basePath, rawAlias],
      protectedPaths: [fixture.basePath],
    });
    expect(pruned.configPaths).not.toContain(rawAlias);

    symlinkSync(targetDir, mountDir, "dir");
    const result = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths: [fixture.basePath, rawAlias, targetPath],
      protectedPaths: [fixture.basePath],
    });

    expect(result.configPaths).toEqual([fixture.basePath, realpathSync(targetPath)]);
    expect(result.config.projects["target"]).toBeDefined();
    expect(result.newDiagnostics).toHaveLength(0);
  });

  it("emits each diagnostic once across repeated scans, independent of scan count", async () => {
    const rootDir = await createTempDir("spur-scanner-once-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const scanner = new ConfigRegistryScanner();
    const configPaths = [
      fixture.basePath,
      fixture.livePath,
      fixture.duplicatePath,
      fixture.missingParentAlivePath,
      fixture.orphanPath,
    ];

    const seenDiagnostics: RegistryDiagnostic[] = [];
    for (let scanIndex = 0; scanIndex < 3; scanIndex += 1) {
      const result = scanner.scan({
        bootstrapConfigPath: fixture.basePath,
        configPaths,
        protectedPaths: [fixture.basePath],
      });
      seenDiagnostics.push(...result.newDiagnostics);
    }

    expect(seenDiagnostics).toHaveLength(2);
    expect(seenDiagnostics.map((diagnostic) => diagnostic.configPath).sort()).toEqual(
      [fixture.duplicatePath, fixture.missingParentAlivePath].sort(),
    );
  });

  it("loads a previously-missing file once it is created", async () => {
    const rootDir = await createTempDir("spur-scanner-reappear-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const scanner = new ConfigRegistryScanner();
    const configPaths = [fixture.basePath, fixture.missingParentAlivePath];

    const first = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths,
      protectedPaths: [fixture.basePath],
    });
    expect(first.newDiagnostics).toHaveLength(1);
    expect(first.newDiagnostics[0]?.message).toContain("Config file not found");
    expect(first.config.projects["revived"]).toBeUndefined();

    const second = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths,
      protectedPaths: [fixture.basePath],
    });
    expect(second.newDiagnostics).toHaveLength(0);

    await writeFile(
      fixture.missingParentAlivePath,
      configYaml({
        port: 4310,
        dataDir: fixture.dataDir,
        worktreeDir: fixture.worktreeDir,
        projectId: "revived",
        projectPath: join(rootDir, "repo-revived"),
        sessionPrefix: "revived",
      }),
      "utf8",
    );

    const third = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths,
      protectedPaths: [fixture.basePath],
    });
    expect(third.newDiagnostics).toHaveLength(0);
    expect(third.config.projects["revived"]).toBeDefined();
  });

  it("validates an unchanged missing path through its parent without touching the child", async () => {
    const rootDir = await createTempDir("spur-scanner-missing-stat-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    let childStats = 0;
    let parentStats = 0;
    const scanner = new ConfigRegistryScanner({
      stat: (path) => {
        if (path === fixture.missingParentAlivePath) childStats += 1;
        if (path === dirname(fixture.missingParentAlivePath)) parentStats += 1;
        const stat = statSync(path);
        return { mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() };
      },
      realpath: (path) => realpathSync(path),
    });
    const options = {
      bootstrapConfigPath: fixture.basePath,
      configPaths: [fixture.basePath, fixture.missingParentAlivePath],
      protectedPaths: [fixture.basePath],
    };

    scanner.scan(options);
    childStats = 0;
    parentStats = 0;
    scanner.scan(options);
    expect(childStats).toBe(0);
    expect(parentStats).toBe(1);

    await writeFile(
      fixture.missingParentAlivePath,
      configYaml({
        port: 4310,
        dataDir: fixture.dataDir,
        worktreeDir: fixture.worktreeDir,
        projectId: "created",
        projectPath: join(rootDir, "repo-created"),
        sessionPrefix: "created",
      }),
      "utf8",
    );
    childStats = 0;
    const result = scanner.scan(options);
    expect(childStats).toBe(1);
    expect(result.config.projects["created"]).toBeDefined();
  });

  it("reconsiders an unchanged duplicate when the earlier owner is removed or reordered", async () => {
    const rootDir = await createTempDir("spur-scanner-duplicate-order-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const scanner = new ConfigRegistryScanner();

    const first = scanner.scan({
      bootstrapConfigPath: fixture.livePath,
      configPaths: [fixture.livePath, fixture.basePath, fixture.duplicatePath],
      protectedPaths: [fixture.livePath],
    });
    expect(first.config.projects["base"]?.path).toBe(join(rootDir, "repo-base"));
    expect(first.newDiagnostics[0]?.configPath).toBe(fixture.duplicatePath);

    const promoted = scanner.scan({
      bootstrapConfigPath: fixture.livePath,
      configPaths: [fixture.livePath, fixture.duplicatePath],
      protectedPaths: [fixture.livePath],
    });
    expect(promoted.config.projects["base"]?.path).toBe(join(rootDir, "repo-dup"));

    const reordered = scanner.scan({
      bootstrapConfigPath: fixture.livePath,
      configPaths: [fixture.livePath, fixture.duplicatePath, fixture.basePath],
      protectedPaths: [fixture.livePath],
    });
    expect(reordered.config.projects["base"]?.path).toBe(join(rootDir, "repo-dup"));
    expect(reordered.newDiagnostics).toHaveLength(1);
    expect(reordered.newDiagnostics[0]?.configPath).toBe(fixture.basePath);
  });

  it("keeps paths when a filesystem error prevents proving parent ENOENT", async () => {
    const rootDir = await createTempDir("spur-scanner-parent-error-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const uncertainPath = join(rootDir, "unavailable", "spur.yaml");
    const uncertainParent = dirname(uncertainPath);
    const scanner = new ConfigRegistryScanner({
      stat: (path) => {
        if (path === uncertainParent) {
          const error = new Error("unavailable") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
        const stat = statSync(path);
        return { mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() };
      },
      realpath: (path) => realpathSync(path),
    });

    const result = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths: [fixture.basePath, uncertainPath],
      protectedPaths: [fixture.basePath],
    });

    expect(result.configPaths).toContain(uncertainPath);
  });

  it("reports a canonical path once even when its diagnostic changes", async () => {
    const rootDir = await createTempDir("spur-scanner-diagnostic-change-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const changingPath = join(rootDir, "changing.yaml");
    await writeFile(changingPath, "projects: [broken]\n", "utf8");
    const scanner = new ConfigRegistryScanner();
    const options = {
      bootstrapConfigPath: fixture.basePath,
      configPaths: [fixture.basePath, changingPath],
      protectedPaths: [fixture.basePath],
    };

    expect(scanner.scan(options).newDiagnostics).toHaveLength(1);
    await writeFile(
      changingPath,
      configYaml({
        port: 4310,
        dataDir: fixture.dataDir,
        worktreeDir: fixture.worktreeDir,
        projectId: "base",
        projectPath: join(rootDir, "repo-changing"),
        sessionPrefix: "changing",
      }),
      "utf8",
    );
    expect(scanner.scan(options).newDiagnostics).toHaveLength(0);
  });

  it("reuses a loaded config while its file stamp is unchanged", async () => {
    const rootDir = await createTempDir("spur-scanner-cache-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const duplicatePath = fixture.duplicatePath;
    // Pin to whole-second time so utimesSync reproduces the same mtimeMs.
    const pinnedMtime = new Date(2020, 0, 1, 0, 0, 0, 0);
    utimesSync(duplicatePath, pinnedMtime, pinnedMtime);
    const originalStat = statSync(duplicatePath);

    const scanner = new ConfigRegistryScanner();
    const configPaths = [fixture.basePath, duplicatePath];

    const first = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths,
      protectedPaths: [fixture.basePath],
    });
    expect(first.newDiagnostics).toHaveLength(1);
    expect(Object.keys(first.config.projects)).toEqual(["base"]);

    // Match original byte length, then restore original stamp.
    await writeFile(
      duplicatePath,
      configYaml({
        port: 4310,
        dataDir: fixture.dataDir,
        worktreeDir: fixture.worktreeDir,
        projectId: "moon",
        projectPath: join(rootDir, "repo-dup"),
        sessionPrefix: "moon-dup",
      }),
      "utf8",
    );
    utimesSync(duplicatePath, pinnedMtime, pinnedMtime);
    expect(statSync(duplicatePath).size).toBe(originalStat.size);
    expect(statSync(duplicatePath).mtimeMs).toBe(originalStat.mtimeMs);

    const second = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths,
      protectedPaths: [fixture.basePath],
    });
    expect(second.newDiagnostics).toHaveLength(0);
    expect(Object.keys(second.config.projects)).toEqual(["base"]);
    expect(second.config.projects["moon"]).toBeUndefined();

    // Bumped mtime invalidates the cache.
    const bumpedMtime = new Date(originalStat.mtime.getTime() + 5000);
    utimesSync(duplicatePath, bumpedMtime, bumpedMtime);

    const third = scanner.scan({
      bootstrapConfigPath: fixture.basePath,
      configPaths,
      protectedPaths: [fixture.basePath],
    });
    expect(third.config.projects["moon"]).toBeDefined();
  });

  it("reuses an invalid verdict until the file stamp changes", async () => {
    const rootDir = await createTempDir("spur-scanner-invalid-cache-");
    tempDirs.push(rootDir);
    const fixture = await setupScannerFixture(rootDir);
    const invalidPath = join(rootDir, "invalid.yaml");
    await writeFile(invalidPath, "projects: [broken]\n", "utf8");
    let candidateStamp = { mtimeMs: 1, size: 1, isFile: true };
    const scanner = new ConfigRegistryScanner({
      stat: (path) => {
        if (path === invalidPath) return candidateStamp;
        const stat = statSync(path);
        return { mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() };
      },
      realpath: (path) => realpathSync(path),
    });
    const options = {
      bootstrapConfigPath: fixture.basePath,
      configPaths: [fixture.basePath, invalidPath],
      protectedPaths: [fixture.basePath],
    };

    expect(scanner.scan(options).newDiagnostics).toHaveLength(1);
    await writeFile(
      invalidPath,
      configYaml({
        port: 4310,
        dataDir: fixture.dataDir,
        worktreeDir: fixture.worktreeDir,
        projectId: "valid",
        projectPath: join(rootDir, "repo-valid"),
        sessionPrefix: "valid",
      }),
      "utf8",
    );
    expect(scanner.scan(options).config.projects["valid"]).toBeUndefined();

    candidateStamp = { mtimeMs: 2, size: 1, isFile: true };
    expect(scanner.scan(options).config.projects["valid"]).toBeDefined();
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

describe("registry.resolveRegisteredDataDirs", () => {
  it("returns both foreign dataDirs and excludes its own", async () => {
    const rootDir = await createTempDir("spur-registry-foreign-dirs-");
    tempDirs.push(rootDir);
    const ownDataDir = join(rootDir, "own-data");
    const foreignDataDirA = join(rootDir, "foreign-a-data");
    const foreignDataDirB = join(rootDir, "foreign-b-data");
    const worktreeDir = join(rootDir, "worktrees");

    const foreignPathA = await writeConfig(
      rootDir,
      "foreign-a.yaml",
      configYaml({
        port: 4311,
        dataDir: foreignDataDirA,
        worktreeDir,
        projectId: "a",
        projectPath: join(rootDir, "repo-a"),
        sessionPrefix: "a",
      }),
    );
    const foreignPathB = await writeConfig(
      rootDir,
      "foreign-b.yaml",
      configYaml({
        port: 4312,
        dataDir: foreignDataDirB,
        worktreeDir,
        projectId: "b",
        projectPath: join(rootDir, "repo-b"),
        sessionPrefix: "b",
      }),
    );
    const ownPath = await writeConfig(
      rootDir,
      "own.yaml",
      configYaml({
        port: 4310,
        dataDir: ownDataDir,
        worktreeDir,
        projectId: "own",
        projectPath: join(rootDir, "repo-own"),
        sessionPrefix: "own",
      }),
    );

    writeConfigRegistry(ownDataDir, [foreignPathA, foreignPathB, ownPath]);

    expect(resolveRegisteredDataDirs(ownDataDir).sort()).toEqual(
      [foreignDataDirA, foreignDataDirB].sort(),
    );
  });

  it("skips a registered path that no longer exists, without throwing", async () => {
    const rootDir = await createTempDir("spur-registry-dead-path-");
    tempDirs.push(rootDir);
    const ownDataDir = join(rootDir, "own-data");
    const missingPath = join(rootDir, "gone.yaml");

    writeConfigRegistry(ownDataDir, [missingPath]);

    expect(resolveRegisteredDataDirs(ownDataDir)).toEqual([]);
  });

  it("skips an unparsable registered config, without throwing", async () => {
    const rootDir = await createTempDir("spur-registry-unparsable-");
    tempDirs.push(rootDir);
    const ownDataDir = join(rootDir, "own-data");
    const brokenPath = await writeConfig(rootDir, "broken.yaml", "not: [valid\n");

    writeConfigRegistry(ownDataDir, [brokenPath]);

    expect(resolveRegisteredDataDirs(ownDataDir)).toEqual([]);
  });

  it("returns [] when no registry file exists", async () => {
    const rootDir = await createTempDir("spur-registry-no-file-");
    tempDirs.push(rootDir);
    const ownDataDir = join(rootDir, "own-data");

    expect(resolveRegisteredDataDirs(ownDataDir)).toEqual([]);
  });

  it("resolves a registered project-shaped config with no dataDir key to the default dataDir", async () => {
    const rootDir = await createTempDir("spur-registry-project-shape-");
    tempDirs.push(rootDir);
    const ownDataDir = join(rootDir, "own-data");
    const projectPath = await writeConfig(
      rootDir,
      "project.yaml",
      `server:
  host: 127.0.0.1
  port: 4313
worktreeDir: ${join(rootDir, "worktrees")}
projects:
  proj:
    path: ${join(rootDir, "repo-proj")}
    defaultBranch: main
    sessionPrefix: proj
`,
    );

    writeConfigRegistry(ownDataDir, [projectPath]);

    expect(resolveRegisteredDataDirs(ownDataDir)).toEqual([join(homedir(), ".spur")]);
  });
});

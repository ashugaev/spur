import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli.js";
import { readCommentSeenRegistry } from "../../src/metadata.js";

// Regression coverage for issue #715: `agent-issue log` and `comment-seen
// record` must resolve `projects` from the merged registry config (the way
// `assertBranchAllowed` already does), not from the bare instance config,
// while `dataDir` keeps coming from the instance config alone.

interface Fixture {
  dataDir: string;
  decoyDataDir: string;
  instanceConfigPath: string;
  registryPath: string;
}

function buildFixture(): Fixture {
  const fixtureDir = mkdtempSync(join(tmpdir(), "spur-cli-project-scope-"));
  const dataDir = join(fixtureDir, "data");
  const worktreeDir = join(fixtureDir, "worktree");
  const projectRepoDir = join(fixtureDir, "repo");
  const decoyDataDir = join(fixtureDir, "decoy-data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(projectRepoDir, { recursive: true });

  const instanceConfigPath = join(fixtureDir, "config.yaml");
  writeFileSync(
    instanceConfigPath,
    `
dataDir: ${dataDir}
worktreeDir: ${worktreeDir}
projects: {}
`,
  );

  const projectConfigPath = join(fixtureDir, "project.yaml");
  writeFileSync(
    projectConfigPath,
    `
dataDir: ${decoyDataDir}
projects:
  zz:
    path: ${projectRepoDir}
    sessionPrefix: zz
    sources:
      pr-watch:
        type: github
`,
  );

  const registryPath = join(dataDir, "config-registry.json");
  writeFileSync(registryPath, JSON.stringify({ configPaths: [projectConfigPath] }));

  return { dataDir, decoyDataDir, instanceConfigPath, registryPath };
}

async function runCli(instanceConfigPath: string, args: string[]): Promise<{ stderr: string }> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
  try {
    await createProgram("/tmp/dist/cli.js").parseAsync([
      "node",
      "spur",
      "--config",
      instanceConfigPath,
      ...args,
    ]);
  } finally {
    spy.mockRestore();
  }
  return { stderr: chunks.join("") };
}

describe("cli project scope (agent-issue log / comment-seen record)", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    delete process.env["SPUR_PROJECT"];
    delete process.env["SPUR_SESSION"];
  });

  it("case 1: agent-issue log appends for a project declared only in a registered config", async () => {
    const fixture = buildFixture();
    process.env["SPUR_PROJECT"] = "zz";
    process.env["SPUR_SESSION"] = "zz-1";

    await runCli(fixture.instanceConfigPath, ["agent-issue", "log", "friction", "probe"]);

    expect(process.exitCode).toBe(originalExitCode);
    const logPath = join(fixture.dataDir, "agent-issues.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record["text"]).toBe("friction probe");
    expect(record["sessionId"]).toBe("zz-1");
    expect(record["projectId"]).toBe("zz");
  });

  it("case 2: comment-seen record writes the seen registry for a project declared only in a registered config", async () => {
    const fixture = buildFixture();
    process.env["SPUR_PROJECT"] = "zz";

    await runCli(fixture.instanceConfigPath, ["comment-seen", "record", "999999"]);

    expect(process.exitCode).toBe(originalExitCode);
    const seen = readCommentSeenRegistry(fixture.dataDir, "zz", "pr-watch");
    expect(seen.has("review-comment:999999")).toBe(true);
  });

  it("case 3: agent-issue log still refuses a genuinely unknown project", async () => {
    const fixture = buildFixture();
    process.env["SPUR_PROJECT"] = "nope";

    const { stderr } = await runCli(fixture.instanceConfigPath, ["agent-issue", "log", "probe"]);

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain("agent-issue log: unknown project nope.");
    expect(existsSync(join(fixture.dataDir, "agent-issues.jsonl"))).toBe(false);
  });

  it("case 4: comment-seen record still refuses a genuinely unknown project", async () => {
    const fixture = buildFixture();
    process.env["SPUR_PROJECT"] = "nope";

    const { stderr } = await runCli(fixture.instanceConfigPath, [
      "comment-seen",
      "record",
      "999999",
    ]);

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain("comment-seen record: unknown project nope.");
    expect(readCommentSeenRegistry(fixture.dataDir, "nope", "pr-watch").size).toBe(0);
  });

  it("case 5: dataDir stays on the instance config, never the registered project config's decoy", async () => {
    const fixture = buildFixture();
    process.env["SPUR_PROJECT"] = "zz";
    process.env["SPUR_SESSION"] = "zz-1";

    await runCli(fixture.instanceConfigPath, ["agent-issue", "log", "friction", "probe"]);

    expect(existsSync(join(fixture.dataDir, "agent-issues.jsonl"))).toBe(true);
    expect(existsSync(fixture.decoyDataDir)).toBe(false);
  });

  it("case 6: a malformed config-registry.json degrades to the instance-only lookup instead of throwing", async () => {
    const fixture = buildFixture();
    writeFileSync(fixture.registryPath, "{ not json");
    process.env["SPUR_PROJECT"] = "zz";

    const { stderr } = await runCli(fixture.instanceConfigPath, ["agent-issue", "log", "probe"]);

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain("agent-issue log: unknown project zz.");
  });
});

import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, execFileAsync } from "../helpers/common.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const autoPushHook = join(repoRoot, ".claude/hooks/auto-push.sh");

type HookRun = {
  stderr: string;
  stdout: string;
};

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  createdDirs.push(dir);
  return dir;
}

async function makeDirtyRepo(): Promise<string> {
  const repoDir = await makeTempDir("spur-auto-push-repo-");
  await execFileAsync("git", ["init", "-b", "feature/hook-json"], { cwd: repoDir });
  await writeFile(join(repoDir, "dirty.txt"), "dirty\n", "utf8");
  return repoDir;
}

async function makeGhStub(): Promise<string> {
  const binDir = await makeTempDir("spur-auto-push-bin-");
  const ghPath = join(binDir, "gh");
  await writeFile(
    ghPath,
    '#!/usr/bin/env sh\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then\n  exit 1\nfi\nexit 1\n',
    "utf8",
  );
  await chmod(ghPath, 0o755);
  return binDir;
}

async function runAutoPushHook(args: string[], env: NodeJS.ProcessEnv): Promise<HookRun> {
  const { stderr, stdout } = await execFileAsync(autoPushHook, args, {
    env: { ...process.env, ...env },
  });
  return { stderr: String(stderr), stdout: String(stdout) };
}

function getStopHookCommands(content: string): string[] {
  const parsed = JSON.parse(content) as {
    hooks?: { Stop?: Array<{ hooks?: Array<{ command?: unknown }> }> };
  };
  return (
    parsed.hooks?.Stop?.flatMap(
      (group) =>
        group.hooks?.flatMap((hook) => (typeof hook.command === "string" ? [hook.command] : [])) ??
        [],
    ) ?? []
  );
}

describe("auto-push Stop hook", () => {
  it("emits valid Codex Stop JSON for dirty branches without a PR", async () => {
    const repoDir = await makeDirtyRepo();
    const binDir = await makeGhStub();

    const result = await runAutoPushHook(["codex"], {
      CLAUDE_PROJECT_DIR: repoDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { decision?: unknown; reason?: unknown };
    expect(parsed.decision).toBe("block");
    if (typeof parsed.reason !== "string") {
      throw new Error("Expected Codex block reason");
    }
    expect(parsed.reason).toContain("Problems: uncommitted no-pr");
    expect(parsed.reason).toContain("$github");
  });

  it("keeps the plain text prompt for non-Codex runtimes", async () => {
    const repoDir = await makeDirtyRepo();
    const binDir = await makeGhStub();

    const result = await runAutoPushHook([], {
      CLAUDE_PROJECT_DIR: repoDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("$github");
    expect(result.stdout).toContain("Problems: uncommitted no-pr");
  });

  it("runs auto-push in Codex mode from Codex hooks config", async () => {
    const content = await readFile(join(repoRoot, ".codex/hooks.json"), "utf8");
    const commands = getStopHookCommands(content);

    expect(commands).toContain(".claude/hooks/auto-push.sh codex");
  });
});

import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execFileAsync } from "../helpers/common.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const autoPushHook = join(repoRoot, ".claude/hooks/auto-push.sh");

type HookRun = {
  code: number | null;
  stderr: string;
  stdout: string;
};

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
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
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(autoPushHook, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stderr, stdout });
    });

    child.stdin.end(
      JSON.stringify({
        hook_event_name: "Stop",
        stop_hook_active: false,
        cwd: env.CLAUDE_PROJECT_DIR,
      }),
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed)) {
      return parsed;
    }
    throw new Error("Expected JSON object");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${message}`, { cause: error });
  }
}

function getStopHookCommands(content: string): string[] {
  const parsed = parseJsonObject(content);
  const hooks = parsed.hooks;
  if (!isRecord(hooks)) {
    return [];
  }

  const stopHooks = hooks.Stop;
  if (!Array.isArray(stopHooks)) {
    return [];
  }

  const commands: string[] = [];
  for (const group of stopHooks) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      continue;
    }

    for (const hook of group.hooks) {
      if (isRecord(hook) && typeof hook.command === "string") {
        commands.push(hook.command);
      }
    }
  }
  return commands;
}

describe("auto-push Stop hook", () => {
  it("emits valid Codex Stop JSON for dirty branches without a PR", async () => {
    const repoDir = await makeDirtyRepo();
    const binDir = await makeGhStub();

    const result = await runAutoPushHook(["codex"], {
      CLAUDE_PROJECT_DIR: repoDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = parseJsonObject(result.stdout);
    expect(parsed.decision).toBe("block");
    expect(typeof parsed.reason).toBe("string");
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

    expect(result.code).toBe(0);
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

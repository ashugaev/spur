import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_GIT_GUARD_SCRIPT, CURSOR_RESTRICT_WRITES_ENV } from "../../src/agents/cursor.js";

let scriptDir: string;
let scriptPath: string;

beforeAll(async () => {
  scriptDir = await mkdtemp(join(tmpdir(), "cursor-git-guard-"));
  scriptPath = join(scriptDir, "restrict-writes-hook.js");
  await writeFile(scriptPath, CURSOR_GIT_GUARD_SCRIPT, "utf8");
});

afterAll(async () => {
  await rm(scriptDir, { recursive: true, force: true });
});

interface HookDecision {
  permission: "allow" | "deny" | "ask";
  user_message?: string;
}

function runGuardRaw(stdin: string, gateOn = true): Promise<HookDecision> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [scriptPath],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          ...(gateOn ? { [CURSOR_RESTRICT_WRITES_ENV]: "1" } : {}),
        },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(JSON.parse(stdout) as HookDecision);
      },
    );
    child.stdin?.end(stdin);
  });
}

function runGuard(command: string, gateOn = true): Promise<HookDecision> {
  return runGuardRaw(JSON.stringify({ command }), gateOn);
}

describe("CURSOR_GIT_GUARD_SCRIPT", () => {
  const denyCommands = [
    "git commit -m x",
    "git push",
    "git -c user.email=a@b commit -m x",
    "git -C /repo push",
    "env FOO=1 git push",
    "FOO=1 git commit -m x",
    "/usr/bin/git push",
    'sh -c "git commit -m y"',
    "bash -c 'git push origin main'",
    "git   commit",
    "git commit --no-verify -m x",
    "git add . && git commit -m z",
    "true || git push",
  ];

  const allowCommands = [
    "git status",
    "git log --oneline",
    "git diff",
    "git add -A",
    "git fetch",
    "git commitfoo",
    "cat file",
    "ls -la",
    "rg pattern",
    "gh pr view",
    "echo git commit",
  ];

  it.each(denyCommands)("denies %s when the gate is on", async (command) => {
    const decision = await runGuard(command);
    expect(decision.permission).toBe("deny");
    expect(decision.user_message).toBeTruthy();
  });

  it.each(allowCommands)("allows %s when the gate is on", async (command) => {
    const decision = await runGuard(command);
    expect(decision.permission).toBe("allow");
  });

  it("allows git commit/push when the gate env is unset", async () => {
    const decision = await runGuard("git commit -m x", false);
    expect(decision.permission).toBe("allow");
  });

  it("allows any command when the gate env is unset", async () => {
    const decision = await runGuard("git push", false);
    expect(decision.permission).toBe("allow");
  });

  it("fails safe (deny) on an unparseable payload when the gate is on", async () => {
    const decision = await runGuardRaw("not json");
    expect(decision.permission).toBe("deny");
  });
});

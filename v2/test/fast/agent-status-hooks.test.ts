import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureAgentStatusHooks,
  removeAgentStatusHooks,
} from "../../src/agents/status-hooks.js";

const cleanupDirs: string[] = [];
const execFileAsync = promisify(execFile);

async function createWorkspace(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const current = cleanupDirs.pop();
    if (current) {
      await rm(current, { recursive: true, force: true });
    }
  }
});

describe("agent status hooks", () => {
  it("merges Claude hook entries without replacing unrelated settings", async () => {
    const worktreePath = await createWorkspace("spur-claude-hooks-");
    const settingsPath = join(worktreePath, ".claude", "settings.json");
    await mkdir(join(worktreePath, ".claude"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          enabledPlugins: {
            "code-simplifier@claude-plugins-official": true,
          },
          Notification: [
            {
              matcher: "auth_success",
              hooks: [{ type: "command", command: "echo auth-ready" }],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    ensureAgentStatusHooks({
      agent: "claude",
      worktreePath,
      statusCommandPath: "/tmp/spur-tools/api-1/spur-session-status",
    });
    ensureAgentStatusHooks({
      agent: "claude",
      worktreePath,
      statusCommandPath: "/tmp/spur-tools/api-1/spur-session-status",
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(settings["enabledPlugins"]).toEqual({
      "code-simplifier@claude-plugins-official": true,
    });
    expect(settings["UserPromptSubmit"]).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "'/tmp/spur-tools/api-1/spur-session-status' 'working'",
            timeout: 5,
          },
        ],
      },
    ]);
    expect(settings["Stop"]).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "'/tmp/spur-tools/api-1/spur-session-status' 'waiting'",
            timeout: 5,
          },
        ],
      },
    ]);
    expect(settings["Notification"]).toEqual([
      {
        matcher: "auth_success",
        hooks: [{ type: "command", command: "echo auth-ready" }],
      },
      {
        matcher: "permission_prompt",
        hooks: [
          {
            type: "command",
            command: "'/tmp/spur-tools/api-1/spur-session-status' 'needs_input'",
            timeout: 5,
          },
        ],
      },
      {
        matcher: "idle_prompt",
        hooks: [
          {
            type: "command",
            command: "'/tmp/spur-tools/api-1/spur-session-status' 'waiting'",
            timeout: 5,
          },
        ],
      },
    ]);

    removeAgentStatusHooks({ agent: "claude", worktreePath });
    const restored = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(restored).toEqual({
      enabledPlugins: {
        "code-simplifier@claude-plugins-official": true,
      },
      Notification: [
        {
          matcher: "auth_success",
          hooks: [{ type: "command", command: "echo auth-ready" }],
        },
      ],
    });
  });

  it("merges Codex hook entries without replacing unrelated hooks", async () => {
    const worktreePath = await createWorkspace("spur-codex-hooks-");
    const hooksPath = join(worktreePath, ".codex", "hooks.json");
    await mkdir(join(worktreePath, ".codex"), { recursive: true });
    await writeFile(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command: ".codex/hooks/code-simplifier.sh",
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    ensureAgentStatusHooks({
      agent: "codex",
      worktreePath,
      statusCommandPath: "/tmp/spur-tools/api-1/spur-session-status",
    });
    ensureAgentStatusHooks({
      agent: "codex",
      worktreePath,
      statusCommandPath: "/tmp/spur-tools/api-1/spur-session-status",
    });

    const hooks = JSON.parse(await readFile(hooksPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(hooks.hooks["UserPromptSubmit"]).toEqual([
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "'/tmp/spur-tools/api-1/spur-session-status' 'working'",
            timeout: 5,
          },
        ],
      },
    ]);
    expect(hooks.hooks["Stop"]).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: ".codex/hooks/code-simplifier.sh",
            timeout: 10,
          },
        ],
      },
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: "'/tmp/spur-tools/api-1/spur-session-status' 'waiting'",
            timeout: 5,
          },
        ],
      },
    ]);

    removeAgentStatusHooks({ agent: "codex", worktreePath });
    const restored = JSON.parse(await readFile(hooksPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(restored).toEqual({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: ".codex/hooks/code-simplifier.sh",
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
  });

  it.each([
    ["claude", ".claude", "settings.json"],
    ["codex", ".codex", "hooks.json"],
  ] as const)("keeps Spur-managed %s hook files out of git status", async (agent, dir, file) => {
    const worktreePath = await createWorkspace(`spur-${agent}-git-`);
    await git(worktreePath, "init");

    ensureAgentStatusHooks({
      agent,
      worktreePath,
      statusCommandPath: "/tmp/spur-tools/api-1/spur-session-status",
    });

    expect(await git(worktreePath, "status", "--short")).toBe("");

    await writeFile(join(worktreePath, "NOTES.txt"), "user change\n", "utf8");
    expect(await git(worktreePath, "status", "--short")).toContain("?? NOTES.txt");

    removeAgentStatusHooks({ agent, worktreePath });

    expect(await git(worktreePath, "status", "--short")).toContain("?? NOTES.txt");
    await expect(readFile(join(worktreePath, dir, file), "utf8")).rejects.toThrow();
  });
});

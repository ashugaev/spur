import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

describe("published interface contracts", () => {
  it("documents closeout ownership in command and agent interfaces", async () => {
    const [commands, agentSkill, claudeSkill] = await Promise.all([
      readRepoFile("docs/commands.md"),
      readRepoFile(".agents/skills/spur/SKILL.md"),
      readRepoFile(".claude/skills/spur/SKILL.md"),
    ]);

    expect(commands).toContain("marks the assigned closeout owner for a writable worktree");
    expect(commands).toContain("transferred handoff ownership on a reused workspace");
    expect(commands).toContain("`0` marks non-owners, including read-only and shared-workspace");
    expect(commands).toContain("missing variable preserves standalone hook enforcement");
    expect(agentSkill).toContain("assigned closeout owner for writable worktree");
    expect(agentSkill).toContain("transferred handoff ownership on reused workspace");
    expect(agentSkill).toContain("`0`: non-owner, including read-only/shared sessions");
    expect(agentSkill).toContain("Missing: standalone hook enforcement stays active");
    expect(claudeSkill).toBe(agentSkill);
  });

  it("documents auto-ping CLI, daemon routes, source support, and agent interface", async () => {
    const [commands, daemonApi, configuration, agentSkill, claudeSkill] = await Promise.all([
      readRepoFile("docs/commands.md"),
      readRepoFile("docs/daemon-api.md"),
      readRepoFile("docs/configuration.md"),
      readRepoFile(".agents/skills/spur/SKILL.md"),
      readRepoFile(".claude/skills/spur/SKILL.md"),
    ]);

    expect(commands).toContain("spur auto-ping unsubscribe --event <handle>");
    expect(commands).toContain("requires exactly one scope flag");
    expect(commands).toContain("Inside a session, `SPUR_SESSION` supplies the target session");
    expect(commands).toContain("never raw handles or handle hashes");
    expect(commands).toContain("Unredeemed handles expire after 30 days");
    expect(commands).toContain("Event suppressions expire 24 hours");
    expect(commands).toContain("grant_not_ready");
    expect(daemonApi).toContain("GET /sessions/:id/auto-ping-suppressions");
    expect(daemonApi).toContain("POST /sessions/:id/auto-ping-suppressions/unsubscribe");
    expect(daemonApi).toContain("POST /sessions/:id/auto-ping-suppressions/:suppressionId/resume");
    expect(daemonApi).toContain("`409` for pending grants or consumed-then-resumed grants");
    expect(configuration).toContain("`github-ci`: event and subscription for spawn triggers");
    expect(configuration).toContain("Cron, Sentry, and GitHub CI send triggers stay unsupported");
    expect(agentSkill).toContain("Auto-ping interface: `docs/commands.md#auto-ping`");
    expect(agentSkill).toContain("HTTP routes: `docs/daemon-api.md`");
    expect(claudeSkill).toBe(agentSkill);
  });
});

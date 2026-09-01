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
});

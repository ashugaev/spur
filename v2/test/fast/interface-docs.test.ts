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

    expect(commands).toContain("`$SPUR_CLOSEOUT_OWNER=1` marks a writable session");
    expect(commands).toContain("`0` marks read-only or shared-workspace sessions");
    expect(commands).toContain("missing variable preserves standalone hook enforcement");
    expect(agentSkill).toContain("`SPUR_CLOSEOUT_OWNER=1`: writable worktree owner");
    expect(agentSkill).toContain("`0`: auto-push Stop hook skips git and PR closeout");
    expect(agentSkill).toContain("Missing: standalone hook enforcement stays active");
    expect(claudeSkill).toBe(agentSkill);
  });
});

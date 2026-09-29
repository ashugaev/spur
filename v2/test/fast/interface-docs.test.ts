import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

describe("published interface contracts", () => {
  it("documents closeout ownership in command docs", async () => {
    const commands = await readRepoFile("docs/commands.md");

    expect(commands).toMatch(/SPUR_CLOSEOUT_OWNER=1[^\n]*`0`/);
  });

  it("documents auto-ping CLI names, daemon routes, source support, and agent interface", async () => {
    const [commands, daemonApi, configuration, agentSkill, claudeSkill] = await Promise.all([
      readRepoFile("docs/commands.md"),
      readRepoFile("docs/daemon-api.md"),
      readRepoFile("docs/configuration.md"),
      readRepoFile(".agents/skills/spur/SKILL.md"),
      readRepoFile(".claude/skills/spur/SKILL.md"),
    ]);

    // Surface names, flags, and codes only — behavioral semantics (TTLs, scope
    // rules, per-source control support) live in code + tests, not doc prose.
    expect(commands).toContain("spur auto-ping unsubscribe --event <handle>");
    expect(commands).toContain("spur auto-ping unsubscribe --thread <handle>");
    expect(commands).toContain("spur auto-ping unsubscribe --subscription <handle>");
    expect(commands).toContain("SPUR_SESSION");
    expect(commands).toContain("--session");
    expect(commands).toContain("grant_not_ready");
    expect(daemonApi).toContain("GET /sessions/:id/auto-ping-suppressions");
    expect(daemonApi).toContain("POST /sessions/:id/auto-ping-suppressions/unsubscribe");
    expect(daemonApi).toContain("POST /sessions/:id/auto-ping-suppressions/:suppressionId/resume");
    expect(daemonApi).toMatch(/auto-ping-suppressions[^\n]*409/);
    expect(daemonApi).toContain("POST /projects/:id/preflight-batches");
    expect(configuration).toContain("projects.<id>.tokenBudget");
    expect(configuration).toContain("session.token_budget.exhausted");
    expect(configuration).toContain("session.token_budget.unenforced");
    expect(configuration).toContain("session.token_budget.teardown_failed");
    expect(configuration).toContain("session.wake.token_budget_blocked");
    expect(configuration).toContain("cron|github|github-ci|gitlab|jira|sentry|service|telegram");
    expect(configuration).toMatch(
      /github-ci[^\n]*no auto-ping controls|no auto-ping controls[^\n]*github-ci/,
    );
    expect(agentSkill).toContain("Stop unwanted auto-pings with `spur auto-ping unsubscribe`");
    expect(agentSkill).toContain("Scopes and resume: `docs/commands.md#auto-ping`");
    expect(agentSkill).toContain("API: `docs/daemon-api.md`");
    expect(claudeSkill).toBe(agentSkill);
  });
});

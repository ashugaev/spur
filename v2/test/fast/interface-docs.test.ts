import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

describe("published interface contracts", () => {
  it("links native Telegram call workflow and source-free launcher opt-out", async () => {
    expect(await readRepoFile("README.md")).toContain("docs/telegram-calls.md");
    expect(await readRepoFile("docs/commands.md")).toContain("SPUR_ISOLATED_WITHOUT_TELEGRAM");
    expect(await readRepoFile("docs/configuration.md")).toContain("voice-call");
    expect(await readRepoFile(".agents/skills/spur/SKILL.md")).toContain("docs/telegram-calls.md");
    expect(await readRepoFile(".claude/skills/spur/SKILL.md")).toBe(
      await readRepoFile(".agents/skills/spur/SKILL.md"),
    );
  });
  it("documents launcher-owned isolated UI discovery environment", async () => {
    const commands = await readRepoFile("docs/commands.md");
    expect(commands).toContain("SPUR_ISOLATED_CONFIG");
    expect(commands).toContain("SPUR_ISOLATED_UI_ENDPOINT_FILE");
    expect(commands).toContain("SPUR_ISOLATED_DAEMON_PID");
    expect(commands).toContain("SPUR_ISOLATED_DAEMON_STARTTIME");
    expect(await readRepoFile("docs/configuration.md")).toContain("v2/src/ports.ts");
  });
  it("names isolated Telegram fixture inputs, stdin seed, and readiness failures", async () => {
    const commands = await readRepoFile("docs/commands.md");
    const configuration = await readRepoFile("docs/configuration.md");
    expect(commands).toContain("isolated-ui");
    expect(commands).toContain("--telegram-env-stdin");
    expect(commands).toContain("Telegram NOT_CONNECTED/missing-fixture");
    expect(commands).toContain("Telegram NOT_CONNECTED/owner-busy");
    for (const field of ["BOT_TOKEN", "CHAT_ID", "ALLOWED_USERS", "ALLOWED_CHATS"])
      expect(configuration).toContain(`TELEGRAM_TEST_${field}`);
  });
  it("documents store routes, the db command and links the store doc", async () => {
    const [readme, commands, daemonApi, stores] = await Promise.all([
      readRepoFile("README.md"),
      readRepoFile("docs/commands.md"),
      readRepoFile("docs/daemon-api.md"),
      readRepoFile("docs/stores.md"),
    ]);
    expect(readme).toContain("docs/stores.md");
    expect(commands).toContain("## db, page");
    expect(commands).toContain("spur db <page:<id>|session:<sid>>");
    for (const route of [
      "GET /stores/:store/docs/:collection",
      "POST /stores/:store/docs/:collection",
      "GET /stores/:store/docs/:collection/:docId",
      "POST /stores/:store/docs/:collection/:docId",
      "PATCH /stores/:store/docs/:collection/:docId",
      "DELETE /stores/:store/docs/:collection/:docId",
      "POST /stores/:store/query/:collection",
      "GET /stores/:store/changes",
    ])
      expect(daemonApi).toContain(`\`${route}\``);
    expect(daemonApi).toContain("## Store routes");
    for (const name of ["page:<pageId>", "session:<sid>", "_actions", "_state", "expectedRev"])
      expect(stores).toContain(name);
    const envelope = await readFile(
      resolve(repoRoot, "v2/test/fixtures/spur-action-envelope.txt"),
      "utf8",
    );
    expect(stores).toContain(envelope.trimEnd());
    expect(commands).toContain("spur db <store> done <action-id>");
    for (const route of [
      "POST /stores/:store/actions",
      "POST /stores/:store/actions/:actionId/complete",
    ])
      expect(daemonApi).toContain(`\`${route}\``);
  });

  it("documents page routes, the page command and links the pages doc", async () => {
    const [readme, commands, daemonApi, pages] = await Promise.all([
      readRepoFile("README.md"),
      readRepoFile("docs/commands.md"),
      readRepoFile("docs/daemon-api.md"),
      readRepoFile("docs/pages.md"),
    ]);
    expect(readme).toContain("docs/pages.md");
    expect(commands).toContain("spur page create <id>");
    for (const route of [
      "GET /pages",
      "POST /pages",
      "DELETE /pages/:id",
      "GET /pages/:id/files/:path",
      "GET /pages/:id/events",
    ])
      expect(daemonApi).toContain(`\`${route}\``);
    for (const name of ["page.yaml", "/p/<id>/", "./_spur/sdk.js", "reload", "spur-page-<id>"])
      expect(pages).toContain(name);
    for (const route of [
      "POST /stores/:store/agent/send",
      "GET /stores/:store/agent/messages",
      "GET /stores/:store/agent/status",
    ])
      expect(daemonApi).toContain(`\`${route}\``);
    const configuration = await readRepoFile("docs/configuration.md");
    expect(configuration).toMatch(/sessionPrefix[^\n]*`pg-\*`[^\n]*`spur-page-\*`/);
  });

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

    // Surface names and flags only — behavioral semantics (TTLs, scope
    // rules, per-source control support) live in code + tests, not doc prose.
    const autoPing = commands.split("## auto-ping")[1]?.split("\n## ")[0] ?? "";
    for (const name of ["auto-ping mute", "auto-ping list", "auto-ping resume"])
      expect(autoPing).toContain(`spur ${name}`);
    for (const flag of ["--for", "--forever", "--reason", "--all"])
      expect(autoPing).toContain(flag);
    expect(autoPing).not.toContain("unsubscribe");
    expect(commands).toContain("SPUR_SESSION");
    expect(commands).toContain("--session");
    expect(daemonApi).toContain("GET /sessions/:id/auto-ping-suppressions");
    expect(daemonApi).toContain("POST /sessions/:id/auto-ping-suppressions/mute");
    expect(daemonApi).toMatch(
      /POST \/sessions\/:id\/auto-ping-suppressions\/resume`[^\n]*`400\|403\|404`/,
    );
    expect(daemonApi).not.toContain("auto-ping-suppressions/unsubscribe");
    expect(daemonApi).toContain("POST /projects/:id/preflight-batches");
    expect(configuration).toContain("projects.<id>.tokenBudget");
    expect(configuration).toContain("projects.<id>.tokenBudgetWarnOnly");
    expect(configuration).toContain("session.token_budget.exhausted");
    expect(configuration).toContain("session.token_budget.unenforced");
    expect(configuration).toContain("session.token_budget.teardown_failed");
    expect(configuration).toContain("session.wake.token_budget_blocked");
    expect(configuration).toContain(
      "cron|script|github|github-ci|gitlab|jira|sentry|service|telegram",
    );
    expect(configuration).toContain("script:item.new");
    expect(configuration).toMatch(
      /github-ci[^\n]*no auto-ping controls|no auto-ping controls[^\n]*github-ci/,
    );
    expect(agentSkill).toContain("Mute unwanted auto-pings with `spur auto-ping mute <handle>`");
    expect(agentSkill).toContain("Modes and resume: `docs/commands.md#auto-ping`");
    expect(agentSkill).toContain("API: `docs/daemon-api.md`");
    expect(claudeSkill).toBe(agentSkill);
  });
});

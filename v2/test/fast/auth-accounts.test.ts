import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthAccounts } from "../../src/auth-accounts.js";

describe("managed authorization accounts", () => {
  let dataDir: string;
  let accounts: AuthAccounts;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "spur-managed-auth-"));
    accounts = new AuthAccounts(dataDir, () => false);
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("keeps independent provider pools and retains managed existence after last removal", () => {
    expect(accounts.read().pools).toEqual({});
    const claude = accounts.add("claude", "Primary");
    const codex = accounts.add("codex", "Work");
    accounts.updatePool("claude", { autoRotate: true });
    accounts.remove(claude.id);
    expect(accounts.read().pools).toEqual({
      claude: { defaultAccountId: null, defaultGeneration: 1, autoRotate: true },
      codex: { defaultAccountId: codex.id, defaultGeneration: 0, autoRotate: false },
    });
  });

  it("increments default generation only for an explicit changed default", () => {
    const first = accounts.add("codex");
    const second = accounts.add("codex");
    accounts.updatePool("codex", { defaultAccountId: first.id, autoRotate: true });
    expect(accounts.read().pools.codex?.defaultGeneration).toBe(0);
    accounts.updatePool("codex", { defaultAccountId: second.id });
    expect(new AuthAccounts(dataDir, () => false).read().pools.codex).toEqual({
      defaultAccountId: second.id,
      defaultGeneration: 1,
      autoRotate: true,
    });
    const other = accounts.add("claude");
    expect(() => accounts.updatePool("codex", { defaultAccountId: other.id })).toThrow();
  });

  it("migrates labels and IDs once without importing credential paths", () => {
    writeFileSync(
      join(dataDir, "claude-accounts.json"),
      JSON.stringify([
        { id: "legacy", label: "Saved", createdAt: "2026-01-01", configDir: "/private/secret" },
      ]),
    );
    expect(accounts.read().accounts).toEqual([
      { id: "legacy", provider: "claude", label: "Saved", createdAt: "2026-01-01" },
    ]);
    expect(readFileSync(join(dataDir, "auth-accounts.json"), "utf8")).not.toContain("secret");
    expect(statSync(join(dataDir, "auth-accounts.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects a corrupt managed store instead of losing the managed boundary", () => {
    writeFileSync(join(dataDir, "auth-accounts.json"), "{");
    expect(() => accounts.read()).toThrow("Invalid managed authorization account store");
  });

  it("retains managed pool existence when migrating an empty legacy account store", () => {
    writeFileSync(join(dataDir, "claude-accounts.json"), "[]");
    expect(accounts.read().pools.claude).toEqual({
      defaultAccountId: null,
      defaultGeneration: 0,
      autoRotate: false,
    });
  });
});

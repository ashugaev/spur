import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthAccounts, authDisplayNames, type AuthIdentity } from "../../src/auth-accounts.js";

function names(
  accounts: { id: string; provider: "claude" | "codex"; identity?: AuthIdentity }[],
): Record<string, string> {
  return Object.fromEntries(authDisplayNames(accounts));
}

describe("authDisplayNames", () => {
  it("names an account by its unique email", () => {
    expect(
      names([
        { id: "a", provider: "claude", identity: { email: "alek@x.com", organizationName: "Org" } },
        { id: "b", provider: "claude", identity: { email: "other@x.com" } },
      ]),
    ).toEqual({ a: "alek@x.com", b: "other@x.com" });
  });

  it("adds the organization when a Claude email repeats", () => {
    expect(
      names([
        {
          id: "a",
          provider: "claude",
          identity: { email: "alek@x.com", organizationName: "Intelas" },
        },
        {
          id: "b",
          provider: "claude",
          identity: { email: "alek@x.com", organizationName: "Personal" },
        },
      ]),
    ).toEqual({ a: "alek@x.com · Intelas", b: "alek@x.com · Personal" });
  });

  it("falls back to the last 4 of the organization id when the secondary repeats or is missing", () => {
    expect(
      names([
        {
          id: "a",
          provider: "claude",
          identity: {
            email: "alek@x.com",
            organizationName: "Org",
            organizationId: "org-aaaa1111",
          },
        },
        {
          id: "b",
          provider: "claude",
          identity: {
            email: "alek@x.com",
            organizationName: "Org",
            organizationId: "org-bbbb2222",
          },
        },
        {
          id: "c",
          provider: "claude",
          identity: { email: "alek@x.com", organizationId: "org-cccc3333" },
        },
      ]),
    ).toEqual({
      a: "alek@x.com · ····1111",
      b: "alek@x.com · ····2222",
      c: "alek@x.com · ····3333",
    });
  });

  it("uses the Codex plan as the secondary and keeps pools apart", () => {
    expect(
      names([
        { id: "a", provider: "codex", identity: { email: "alek@x.com", plan: "Pro" } },
        { id: "b", provider: "codex", identity: { email: "alek@x.com", plan: "Plus" } },
        { id: "c", provider: "claude", identity: { email: "alek@x.com" } },
      ]),
    ).toEqual({ a: "alek@x.com · Pro", b: "alek@x.com · Plus", c: "alek@x.com" });
  });

  it("names API keys by hint and unidentified accounts by provider", () => {
    expect(
      names([
        { id: "k", provider: "claude", identity: { keyHint: "7Q2c" } },
        { id: "n", provider: "codex" },
        { id: "m", provider: "claude" },
      ]),
    ).toEqual({ k: "API key ····7Q2c", n: "New Codex account", m: "New Claude account" });
  });
});

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
    const claude = accounts.add("claude");
    const codex = accounts.add("codex");
    accounts.updatePool("claude", { autoRotate: true });
    accounts.remove(claude.id, () => true);
    expect(accounts.read().pools).toEqual({
      claude: { defaultAccountId: null, defaultGeneration: 1, autoRotate: true },
      codex: { defaultAccountId: codex.id, defaultGeneration: 0, autoRotate: false },
    });
  });

  it("moves a removed default to the first ready account", () => {
    const first = accounts.add("claude");
    const unready = accounts.add("claude");
    const ready = accounts.add("claude");
    accounts.remove(first.id, (id) => id === ready.id);
    expect(accounts.read().pools.claude?.defaultAccountId).toBe(ready.id);
    accounts.remove(ready.id, (id) => id !== unready.id);
    expect(accounts.read().pools.claude?.defaultAccountId).toBeNull();
  });

  it("creates a missing pool on update so its preferences can be set before accounts", () => {
    const seeded = new AuthAccounts(dataDir, () => true);
    expect(seeded.updatePool("codex", { autoRotate: false })).toEqual({
      defaultAccountId: null,
      defaultGeneration: 0,
      autoRotate: false,
    });
    expect(seeded.updatePool("claude", {})).toMatchObject({ autoRotate: true });
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

  it("migrates IDs once, dropping labels and credential paths", () => {
    writeFileSync(
      join(dataDir, "claude-accounts.json"),
      JSON.stringify([
        { id: "legacy", label: "Saved", createdAt: "2026-01-01", configDir: "/private/secret" },
      ]),
    );
    expect(accounts.read().accounts).toEqual([
      { id: "legacy", provider: "claude", createdAt: "2026-01-01" },
    ]);
    const stored = readFileSync(join(dataDir, "auth-accounts.json"), "utf8");
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("Saved");
    expect(statSync(join(dataDir, "auth-accounts.json")).mode & 0o777).toBe(0o600);
  });

  it("strips a stored label on read and omits it after the next write", () => {
    writeFileSync(
      join(dataDir, "auth-accounts.json"),
      JSON.stringify({
        schema: 1,
        accounts: [{ id: "a", provider: "claude", label: "Typed", createdAt: "2026-01-01" }],
        pools: {},
      }),
    );
    expect(accounts.read().accounts).toEqual([
      { id: "a", provider: "claude", createdAt: "2026-01-01" },
    ]);
    accounts.add("codex");
    expect(readFileSync(join(dataDir, "auth-accounts.json"), "utf8")).not.toContain("Typed");
  });

  it("records identity once and writes only on change", () => {
    const account = accounts.add("codex");
    const file = join(dataDir, "auth-accounts.json");
    accounts.recordIdentities([
      { id: account.id, identity: { email: "a@x.com", plan: "pro" } },
      { id: "unknown", identity: { email: "ignored@x.com" } },
      { id: account.id },
    ]);
    expect(accounts.read().accounts[0]?.identity).toEqual({ email: "a@x.com", plan: "Pro" });
    utimesSync(file, new Date(1_000), new Date(1_000));
    accounts.recordIdentities([{ id: account.id, identity: { email: "a@x.com", plan: "pro" } }]);
    expect(statSync(file).mtimeMs).toBe(1_000);
    accounts.recordIdentities([{ id: account.id, identity: { email: "b@x.com", plan: "pro" } }]);
    expect(statSync(file).mtimeMs).not.toBe(1_000);
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

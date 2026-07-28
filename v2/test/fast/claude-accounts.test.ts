import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountStatus,
  addAccount,
  addSetupTokenAccount,
  enrollSetupToken,
  ensureAccountProjectsLink,
  ensureDefaultAccount,
  findAccount,
  listAccounts,
  publicAccount,
  readSetupToken,
  removeAccount,
  touchAccountUsed,
} from "../../src/claude-accounts.js";

describe("claude-accounts store", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "spur-accounts-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns an empty list when the store file is absent", () => {
    expect(listAccounts(dataDir)).toEqual([]);
  });

  it("migrates version-1 records to legacy accounts without reading credentials", () => {
    const configDir = join(dataDir, "claude-accounts", "legacy");
    writeFileSync(
      join(dataDir, "claude-accounts.json"),
      JSON.stringify([
        {
          id: "legacy",
          label: "old",
          configDir,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    const account = listAccounts(dataDir)[0];
    expect(account).toMatchObject({ id: "legacy", kind: "legacy_profile" });
    expect(account && publicAccount(dataDir, account).status).toBe("legacy");
  });

  it("stores only metadata in the index and a private regular secret", () => {
    const token = "setup-token-secret";
    const account = addSetupTokenAccount(dataDir, {
      label: "work",
      setupToken: token,
      validatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const dir = join(dataDir, "claude-accounts", account.id);
    const secret = join(dir, "setup-token");
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(secret).mode & 0o777).toBe(0o600);
    expect(lstatSync(secret).isFile()).toBe(true);
    expect(readSetupToken(dataDir, account)).toBe(token);
    expect(readFileSync(join(dataDir, "claude-accounts.json"), "utf8")).not.toContain(token);
    expect(publicAccount(dataDir, account)).not.toHaveProperty("tokenFingerprint");
  });

  it("rejects permissive and symlink secrets", () => {
    const account = addSetupTokenAccount(dataDir, { setupToken: "secret" });
    const secret = join(dataDir, "claude-accounts", account.id, "setup-token");
    chmodSync(secret, 0o644);
    expect(accountStatus(dataDir, account)).toBe("insecure");
    expect(() => readSetupToken(dataDir, account)).toThrow("insecure");
    chmodSync(secret, 0o700);
    expect(accountStatus(dataDir, account)).toBe("insecure");
    rmSync(secret);
    symlinkSync(join(dataDir, "elsewhere"), secret);
    expect(accountStatus(dataDir, account)).toBe("insecure");
  });

  it("rejects a mode-safe secret whose content does not match metadata", () => {
    const account = addSetupTokenAccount(dataDir, { setupToken: "original" });
    const secret = join(dataDir, "claude-accounts", account.id, "setup-token");
    writeFileSync(secret, "replacement", { mode: 0o600 });

    expect(accountStatus(dataDir, account)).toBe("insecure");
    expect(() => readSetupToken(dataDir, account)).toThrow(/does not match/);
  });

  it("marks enrollment-expired accounts unavailable", () => {
    const account = addSetupTokenAccount(dataDir, {
      setupToken: "secret",
      validatedAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    expect(accountStatus(dataDir, account, Date.parse("2026-01-02T00:00:00.000Z"))).toBe(
      "expired",
    );
  });

  it("re-enrolls in place and removes all account files", () => {
    const account = addSetupTokenAccount(dataDir, { setupToken: "old" });
    const next = enrollSetupToken(dataDir, account.id, "new");
    expect(next.id).toBe(account.id);
    expect(readSetupToken(dataDir, next)).toBe("new");
    touchAccountUsed(dataDir, account.id);
    expect(findAccount(dataDir, account.id)?.lastUsedAt).toBeTruthy();
    removeAccount(dataDir, account.id);
    expect(listAccounts(dataDir)).toEqual([]);
    expect(existsSync(join(dataDir, "claude-accounts", account.id))).toBe(false);
  });
});

describe("ensureDefaultAccount", () => {
  let dataDir: string;
  let defaultConfigDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "spur-accounts-"));
    defaultConfigDir = mkdtempSync(join(tmpdir(), "spur-default-claude-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(defaultConfigDir, { recursive: true, force: true });
  });

  it("adopt-present: adopts default account when credentials exist", () => {
    writeFileSync(join(defaultConfigDir, ".credentials.json"), "{}", "utf-8");
    ensureDefaultAccount(dataDir, defaultConfigDir);
    const accounts = listAccounts(dataDir);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "default",
      label: "default",
      configDir: defaultConfigDir,
    });
  });

  it("idempotent: calling twice keeps length 1", () => {
    writeFileSync(join(defaultConfigDir, ".credentials.json"), "{}", "utf-8");
    ensureDefaultAccount(dataDir, defaultConfigDir);
    ensureDefaultAccount(dataDir, defaultConfigDir);
    expect(listAccounts(dataDir)).toHaveLength(1);
  });

  it("absent-noop: no credentials, store stays empty", () => {
    ensureDefaultAccount(dataDir, defaultConfigDir);
    expect(listAccounts(dataDir)).toEqual([]);
  });
});

describe("ensureAccountProjectsLink", () => {
  let dataDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "spur-accounts-"));
    fakeHome = mkdtempSync(join(tmpdir(), "spur-fake-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("addAccount creates a symlink at <configDir>/projects pointing at homedir()/.claude/projects", () => {
    const account = addAccount(dataDir);
    const link = join(account.configDir, "projects");
    const target = join(homedir(), ".claude", "projects");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readlinkSync(link)).toBe(target);
  });

  it("idempotent: second call on an already-linked account is a no-op", () => {
    const account = addAccount(dataDir);
    expect(() => ensureAccountProjectsLink(account)).not.toThrow();
    const link = join(account.configDir, "projects");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(homedir(), ".claude", "projects"));
  });

  it("wrong-target: re-points a symlink that points to a different directory", () => {
    const account = addAccount(dataDir);
    const link = join(account.configDir, "projects");
    const target = join(homedir(), ".claude", "projects");
    const wrongTarget = mkdtempSync(join(tmpdir(), "spur-wrong-"));
    try {
      unlinkSync(link);
      symlinkSync(wrongTarget, link);
      ensureAccountProjectsLink(account);
      expect(readlinkSync(link)).toBe(target);
    } finally {
      rmSync(wrongTarget, { recursive: true, force: true });
    }
  });

  it("migration: moves existing real directory contents into shared target", () => {
    const account = addAccount(dataDir);
    const link = join(account.configDir, "projects");
    const target = join(homedir(), ".claude", "projects");
    unlinkSync(link);
    const sub = join(link, "sess-abc");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "x.jsonl"), "transcript", "utf-8");
    ensureAccountProjectsLink(account);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(join(target, "sess-abc", "x.jsonl"), "utf-8")).toBe("transcript");
  });

  it("migration-merge: merges into pre-existing shared target subdirectory", () => {
    const account = addAccount(dataDir);
    const link = join(account.configDir, "projects");
    const target = join(homedir(), ".claude", "projects");
    unlinkSync(link);
    const sub = join(link, "sess-shared");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "a.jsonl"), "from-account", "utf-8");
    mkdirSync(join(target, "sess-shared"), { recursive: true });
    writeFileSync(join(target, "sess-shared", "b.jsonl"), "pre-existing", "utf-8");
    ensureAccountProjectsLink(account);
    expect(readFileSync(join(target, "sess-shared", "a.jsonl"), "utf-8")).toBe("from-account");
    expect(readFileSync(join(target, "sess-shared", "b.jsonl"), "utf-8")).toBe("pre-existing");
  });

  it("default-link-noop: default account configDir skips symlink creation", () => {
    const account = {
      kind: "legacy_profile" as const,
      id: "default",
      label: "default",
      configDir: join(homedir(), ".claude"),
      createdAt: new Date().toISOString(),
    };
    expect(() => ensureAccountProjectsLink(account)).not.toThrow();
  });

  it("remove-safety: removeAccount only removes <accountsRoot>/<id>, not an external configDir", () => {
    const externalDir = mkdtempSync(join(tmpdir(), "spur-external-"));
    const sentinel = join(externalDir, "sentinel.txt");
    writeFileSync(sentinel, "keep-me", "utf-8");
    const account = addAccount(dataDir, { label: "ext" });
    // Patch stored configDir to simulate an external (e.g. default) account
    const accounts = listAccounts(dataDir);
    const accountsPath = join(dataDir, "claude-accounts.json");
    writeFileSync(
      accountsPath,
      JSON.stringify(
        accounts.map((a) => (a.id === account.id ? { ...a, configDir: externalDir } : a)),
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    removeAccount(dataDir, account.id);
    expect(listAccounts(dataDir)).toEqual([]);
    expect(existsSync(externalDir)).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
    rmSync(externalDir, { recursive: true, force: true });
  });
});

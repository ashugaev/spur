import {
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
  addAccount,
  ensureAccountProjectsLink,
  ensureDefaultAccount,
  findAccount,
  isAccountAuthenticated,
  listAccounts,
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

  it("addAccount creates the config dir and appends to the index", () => {
    const account = addAccount(dataDir, { label: "work" });
    expect(account.id).toBeTruthy();
    expect(account.label).toBe("work");
    expect(account.configDir).toBe(join(dataDir, "claude-accounts", account.id));
    expect(existsSync(account.configDir)).toBe(true);

    const listed = listAccounts(dataDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(account.id);
  });

  it("findAccount locates by id", () => {
    const a = addAccount(dataDir);
    const b = addAccount(dataDir);
    expect(findAccount(dataDir, b.id)?.id).toBe(b.id);
    expect(findAccount(dataDir, a.id)?.id).toBe(a.id);
    expect(findAccount(dataDir, "ghost")).toBeUndefined();
  });

  it("isAccountAuthenticated reflects .credentials.json presence", () => {
    const account = addAccount(dataDir);
    expect(isAccountAuthenticated(account)).toBe(false);
    writeFileSync(join(account.configDir, ".credentials.json"), "{}", "utf-8");
    expect(isAccountAuthenticated(account)).toBe(true);
  });

  it("removeAccount deletes the index entry and the config dir", () => {
    const account = addAccount(dataDir);
    expect(existsSync(account.configDir)).toBe(true);
    removeAccount(dataDir, account.id);
    expect(listAccounts(dataDir)).toEqual([]);
    expect(existsSync(account.configDir)).toBe(false);
  });

  it("touchAccountUsed records lastUsedAt", () => {
    const account = addAccount(dataDir);
    expect(findAccount(dataDir, account.id)?.lastUsedAt).toBeUndefined();
    touchAccountUsed(dataDir, account.id);
    expect(findAccount(dataDir, account.id)?.lastUsedAt).toBeTruthy();
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

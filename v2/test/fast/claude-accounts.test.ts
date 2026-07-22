import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAccount,
  ensureAccountProjectsLink,
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

describe("ensureAccountProjectsLink", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "spur-accounts-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("addAccount creates a symlink at <configDir>/projects pointing at homedir()/.claude/projects", () => {
    const account = addAccount(dataDir);
    const link = join(account.configDir, "projects");
    const target = join(homedir(), ".claude", "projects");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readlinkSync(link)).toBe(join(homedir(), ".claude", "projects"));
  });

  it("ensureAccountProjectsLink is idempotent", () => {
    const account = addAccount(dataDir);
    expect(() => ensureAccountProjectsLink(account)).not.toThrow();
    const link = join(account.configDir, "projects");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("throws when <configDir>/projects is a real directory", () => {
    const account = addAccount(dataDir);
    const link = join(account.configDir, "projects");
    unlinkSync(link);
    mkdirSync(link);
    expect(() => ensureAccountProjectsLink(account)).toThrow(/exists as a real directory/);
  });
});

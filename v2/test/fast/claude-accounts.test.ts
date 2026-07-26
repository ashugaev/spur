import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountStatus,
  addSetupTokenAccount,
  enrollSetupToken,
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
    rmSync(secret);
    symlinkSync(join(dataDir, "elsewhere"), secret);
    expect(accountStatus(dataDir, account)).toBe("insecure");
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

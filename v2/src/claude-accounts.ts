import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const ACCOUNTS_FILE = "claude-accounts.json";
const ACCOUNTS_DIR = "claude-accounts";
const SECRET_FILE = "setup-token";
const STORE_VERSION = 2;
const TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;

interface ClaudeAccountBase {
  id: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface SetupTokenClaudeAccount extends ClaudeAccountBase {
  kind: "setup_token";
  tokenFingerprint: string;
  validatedAt: string;
  expiresAt: string;
}

export interface LegacyClaudeAccount extends ClaudeAccountBase {
  kind: "legacy_profile";
  configDir: string;
}

export type ClaudeAccount = SetupTokenClaudeAccount | LegacyClaudeAccount;
export type ClaudeAccountStatus = "ready" | "legacy" | "expired" | "insecure";

export interface PublicClaudeAccount {
  id: string;
  label?: string;
  status: ClaudeAccountStatus;
  expiresAt?: string;
  lastUsedAt?: string;
}

function accountsFilePath(dataDir: string): string {
  return join(dataDir, ACCOUNTS_FILE);
}

function accountsRootDir(dataDir: string): string {
  return join(dataDir, ACCOUNTS_DIR);
}

function accountDir(dataDir: string, id: string): string {
  return join(accountsRootDir(dataDir), id);
}

function secretPath(dataDir: string, id: string): string {
  return join(accountDir(dataDir, id), SECRET_FILE);
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmpPath, path);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAccount(value: unknown): ClaudeAccount | undefined {
  if (!isRecord(value)) return undefined;
  const { id, label, createdAt, lastUsedAt } = value;
  if (
    !isString(id) ||
    !isOptionalString(label) ||
    !isString(createdAt) ||
    !isOptionalString(lastUsedAt)
  ) {
    return undefined;
  }
  const common = {
    id,
    ...(label ? { label } : {}),
    createdAt,
    ...(lastUsedAt ? { lastUsedAt } : {}),
  };
  if (
    value.kind === "setup_token" &&
    isString(value.tokenFingerprint) &&
    isString(value.validatedAt) &&
    isString(value.expiresAt)
  ) {
    return {
      kind: "setup_token",
      ...common,
      tokenFingerprint: value.tokenFingerprint,
      validatedAt: value.validatedAt,
      expiresAt: value.expiresAt,
    };
  }
  if (value.kind === "legacy_profile" && isString(value.configDir)) {
    return { kind: "legacy_profile", ...common, configDir: value.configDir };
  }
  // Version-1 records had no discriminator.
  if (isString(value.configDir)) {
    return { kind: "legacy_profile", ...common, configDir: value.configDir };
  }
  return undefined;
}

export function listAccounts(dataDir: string): ClaudeAccount[] {
  let raw: string;
  try {
    raw = readFileSync(accountsFilePath(dataDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries =
    Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && parsed.version === STORE_VERSION && Array.isArray(parsed.accounts)
        ? parsed.accounts
        : [];
  return entries.map(parseAccount).filter((account): account is ClaudeAccount => !!account);
}

function writeAccounts(dataDir: string, accounts: ClaudeAccount[]): void {
  writeJsonFile(accountsFilePath(dataDir), { version: STORE_VERSION, accounts });
}

export function findAccount(dataDir: string, id: string): ClaudeAccount | undefined {
  return listAccounts(dataDir).find((account) => account.id === id);
}

export function fingerprintSetupToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

function assertAccountId(id: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error("Invalid Claude account id");
  }
}

function writeSecret(dataDir: string, id: string, setupToken: string): void {
  assertAccountId(id);
  const dir = accountDir(dataDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const target = secretPath(dataDir, id);
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporary, setupToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function secretIsSecure(dataDir: string, id: string): boolean {
  try {
    const stat = lstatSync(secretPath(dataDir, id));
    return stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export function readSetupToken(dataDir: string, account: SetupTokenClaudeAccount): string {
  if (!secretIsSecure(dataDir, account.id)) {
    throw new Error("Claude account secret is insecure; re-enroll the account");
  }
  return readFileSync(secretPath(dataDir, account.id), "utf8");
}

export function accountStatus(
  dataDir: string,
  account: ClaudeAccount,
  now = Date.now(),
): ClaudeAccountStatus {
  if (account.kind === "legacy_profile") return "legacy";
  if (Date.parse(account.expiresAt) <= now) return "expired";
  return secretIsSecure(dataDir, account.id) ? "ready" : "insecure";
}

export function publicAccount(
  dataDir: string,
  account: ClaudeAccount,
  now = Date.now(),
): PublicClaudeAccount {
  const status = accountStatus(dataDir, account, now);
  return {
    id: account.id,
    ...(account.label ? { label: account.label } : {}),
    status,
    ...(account.kind === "setup_token" ? { expiresAt: account.expiresAt } : {}),
    ...(account.lastUsedAt ? { lastUsedAt: account.lastUsedAt } : {}),
  };
}

export function addSetupTokenAccount(
  dataDir: string,
  opts: { label?: string; setupToken: string; validatedAt?: Date },
): SetupTokenClaudeAccount {
  const id = randomUUID();
  const validatedAt = opts.validatedAt ?? new Date();
  const label = opts.label?.trim();
  const account: SetupTokenClaudeAccount = {
    kind: "setup_token",
    id,
    ...(label ? { label } : {}),
    createdAt: validatedAt.toISOString(),
    tokenFingerprint: fingerprintSetupToken(opts.setupToken),
    validatedAt: validatedAt.toISOString(),
    expiresAt: new Date(validatedAt.getTime() + TOKEN_LIFETIME_MS).toISOString(),
  };
  try {
    writeSecret(dataDir, id, opts.setupToken);
    writeAccounts(dataDir, [...listAccounts(dataDir), account]);
    return account;
  } catch (error) {
    rmSync(accountDir(dataDir, id), { recursive: true, force: true });
    throw error;
  }
}

export function enrollSetupToken(
  dataDir: string,
  id: string,
  setupToken: string,
  validatedAt = new Date(),
): SetupTokenClaudeAccount {
  const existing = findAccount(dataDir, id);
  if (!existing) throw new Error("Claude account not found");
  const account: SetupTokenClaudeAccount = {
    kind: "setup_token",
    id,
    ...(existing.label ? { label: existing.label } : {}),
    createdAt: existing.createdAt,
    ...(existing.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    tokenFingerprint: fingerprintSetupToken(setupToken),
    validatedAt: validatedAt.toISOString(),
    expiresAt: new Date(validatedAt.getTime() + TOKEN_LIFETIME_MS).toISOString(),
  };
  writeSecret(dataDir, id, setupToken);
  writeAccounts(
    dataDir,
    listAccounts(dataDir).map((candidate) => (candidate.id === id ? account : candidate)),
  );
  return account;
}

// Compatibility helper for version-1 tests and records. New enrollment uses setup tokens.
export function addAccount(dataDir: string, opts: { label?: string } = {}): LegacyClaudeAccount {
  const id = randomUUID();
  const configDir = accountDir(dataDir, id);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const label = opts.label?.trim();
  const account: LegacyClaudeAccount = {
    kind: "legacy_profile",
    id,
    ...(label ? { label } : {}),
    configDir,
    createdAt: new Date().toISOString(),
  };
  writeAccounts(dataDir, [...listAccounts(dataDir), account]);
  return account;
}

export function removeAccount(dataDir: string, id: string): void {
  assertAccountId(id);
  writeAccounts(
    dataDir,
    listAccounts(dataDir).filter((account) => account.id !== id),
  );
  rmSync(accountDir(dataDir, id), { recursive: true, force: true });
}

export function touchAccountUsed(dataDir: string, id: string): void {
  writeAccounts(
    dataDir,
    listAccounts(dataDir).map((account) =>
      account.id === id ? { ...account, lastUsedAt: new Date().toISOString() } : account,
    ),
  );
}

import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Runtime store of Claude login accounts. Each account is an isolated
// CLAUDE_CONFIG_DIR directory created/selected/removed via the UI. Config no
// longer declares accounts; it carries only the auto-rotate toggle. Mirrors the
// flat-store + atomic-write pattern of registry.ts.

const ACCOUNTS_FILE = "claude-accounts.json";
const ACCOUNTS_DIR = "claude-accounts";

export interface ClaudeAccount {
  id: string;
  label?: string;
  configDir: string;
  createdAt: string;
  lastUsedAt?: string;
}

function accountsFilePath(dataDir: string): string {
  return join(dataDir, ACCOUNTS_FILE);
}

function accountsRootDir(dataDir: string): string {
  return join(dataDir, ACCOUNTS_DIR);
}

function accountConfigDir(dataDir: string, id: string): string {
  return join(accountsRootDir(dataDir), id);
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

function isClaudeAccount(value: unknown): value is ClaudeAccount {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<ClaudeAccount>;
  return (
    typeof entry.id === "string" &&
    typeof entry.configDir === "string" &&
    typeof entry.createdAt === "string"
  );
}

export function listAccounts(dataDir: string): ClaudeAccount[] {
  const path = accountsFilePath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isClaudeAccount);
}

function writeAccounts(dataDir: string, accounts: ClaudeAccount[]): void {
  writeJsonFile(accountsFilePath(dataDir), accounts);
}

export function findAccount(dataDir: string, id: string): ClaudeAccount | undefined {
  return listAccounts(dataDir).find((account) => account.id === id);
}

function mergeProjectsInto(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const srcPath = join(source, entry.name);
    const dstPath = join(target, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(dstPath)) {
        mergeProjectsInto(srcPath, dstPath);
      } else {
        renameSync(srcPath, dstPath);
      }
    } else {
      renameSync(srcPath, dstPath);
    }
  }
}

function linkProjectsDir(link: string, target: string): void {
  try {
    symlinkSync(target, link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const st = lstatSync(link);
      if (st.isSymbolicLink() && readlinkSync(link) === target) return;
    }
    throw error;
  }
}

export function ensureAccountProjectsLink(account: Pick<ClaudeAccount, "configDir">): void {
  const target = join(homedir(), ".claude", "projects");
  mkdirSync(target, { recursive: true });
  const link = join(account.configDir, "projects");
  if (link === target) return;

  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      linkProjectsDir(link, target);
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    if (readlinkSync(link) === target) return;
    unlinkSync(link);
    linkProjectsDir(link, target);
    return;
  }

  if (stat.isDirectory()) {
    mergeProjectsInto(link, target);
    rmSync(link, { recursive: true, force: true });
    linkProjectsDir(link, target);
    return;
  }

  throw new Error(`${link} exists but is neither a symlink nor a directory`);
}

export function addAccount(dataDir: string, opts: { label?: string } = {}): ClaudeAccount {
  const id = randomUUID();
  const configDir = accountConfigDir(dataDir, id);
  mkdirSync(configDir, { recursive: true });
  const label = opts.label?.trim();
  const account: ClaudeAccount = {
    id,
    ...(label ? { label } : {}),
    configDir,
    createdAt: new Date().toISOString(),
  };
  writeAccounts(dataDir, [...listAccounts(dataDir), account]);
  ensureAccountProjectsLink(account);
  return account;
}

export function removeAccount(dataDir: string, id: string): void {
  const remaining = listAccounts(dataDir).filter((account) => account.id !== id);
  writeAccounts(dataDir, remaining);
  const configDir = accountConfigDir(dataDir, id);
  // Guard: only ever recursively remove directories under the accounts root.
  if (configDir.startsWith(accountsRootDir(dataDir) + "/")) {
    rmSync(configDir, { recursive: true, force: true });
  }
}

export function isAccountAuthenticated(account: Pick<ClaudeAccount, "configDir">): boolean {
  return existsSync(join(account.configDir, ".credentials.json"));
}

// The host account uses ~/.claude as configDir but writes its onboarding
// flag to ~/.claude.json, not ~/.claude/.claude.json. Isolated accounts
// write to <configDir>/.claude.json.
export function onboardingFilePath(configDir: string): string {
  if (configDir === join(homedir(), ".claude")) {
    return join(homedir(), ".claude.json");
  }
  return join(configDir, ".claude.json");
}

export function isAccountReady(account: Pick<ClaudeAccount, "configDir">): boolean {
  if (!isAccountAuthenticated(account)) return false;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(onboardingFilePath(account.configDir), "utf-8"),
    );
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).hasCompletedOnboarding === true
    );
  } catch {
    return false;
  }
}

export function sessionClaudeHome(sessionToolDir: string): string {
  return join(sessionToolDir, "claude-home");
}

export function seedSessionHome(sessionHome: string, account: ClaudeAccount): void {
  mkdirSync(sessionHome, { recursive: true });
  const credentialsPath = join(sessionHome, ".credentials.json");
  if (!existsSync(credentialsPath)) {
    copyFileSync(join(account.configDir, ".credentials.json"), credentialsPath);
  }
  const dotClaudeJson = join(sessionHome, ".claude.json");
  if (!existsSync(dotClaudeJson)) {
    copyFileSync(onboardingFilePath(account.configDir), dotClaudeJson);
  }
  ensureAccountProjectsLink({ configDir: sessionHome });
}

export function swapSessionCredentials(sessionHome: string, account: ClaudeAccount): void {
  const ts = `${process.pid}.${Date.now()}`;
  const credTmp = join(sessionHome, `.credentials.json.tmp.${ts}`);
  try {
    copyFileSync(join(account.configDir, ".credentials.json"), credTmp);
    renameSync(credTmp, join(sessionHome, ".credentials.json"));
  } catch (error) {
    try {
      unlinkSync(credTmp);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

export function ensureDefaultAccount(
  dataDir: string,
  defaultConfigDir: string = join(homedir(), ".claude"),
): void {
  if (!existsSync(join(defaultConfigDir, ".credentials.json"))) return;
  const existing = listAccounts(dataDir);
  if (existing.some((a) => a.configDir === defaultConfigDir)) return;
  const account: ClaudeAccount = {
    id: "default",
    label: "default",
    configDir: defaultConfigDir,
    createdAt: new Date().toISOString(),
  };
  writeAccounts(dataDir, [...existing, account]);
}

export function touchAccountUsed(dataDir: string, id: string): void {
  const accounts = listAccounts(dataDir);
  const next = accounts.map((account) =>
    account.id === id ? { ...account, lastUsedAt: new Date().toISOString() } : account,
  );
  writeAccounts(dataDir, next);
}

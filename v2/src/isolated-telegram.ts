import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIELDS = [
  "TELEGRAM_TEST_BOT_TOKEN",
  "TELEGRAM_TEST_CHAT_ID",
  "TELEGRAM_TEST_ALLOWED_USERS",
  "TELEGRAM_TEST_ALLOWED_CHATS",
] as const;
export interface IsolatedTelegramCredentials {
  token: string;
  chatId: number;
  allowedUsers: number[];
  allowedChats: number[];
}

function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (
    stat.uid !== process.getuid?.() ||
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (!directory && stat.nlink !== 1) ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
  ) {
    throw new Error("Telegram TEST fixture has unsafe ownership or permissions");
  }
}

function privateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw new Error("Cannot create Telegram TEST private directory", { cause: error });
  }
  privatePath(path, true);
}

function validate(input: string): IsolatedTelegramCredentials {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("Malformed Telegram TEST fixture JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Malformed Telegram TEST fixture JSON");
  const fields = value as Record<string, unknown>;
  for (const field of FIELDS) {
    if (typeof fields[field] !== "string" || !fields[field].trim())
      throw new Error(`Missing ${field}`);
  }
  if (Object.keys(fields).some((field) => !FIELDS.includes(field as (typeof FIELDS)[number])))
    throw new Error("Unexpected Telegram TEST fixture field");
  const token = (fields["TELEGRAM_TEST_BOT_TOKEN"] as string).trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid TELEGRAM_TEST_BOT_TOKEN");
  function ids(field: (typeof FIELDS)[number]): number[] {
    const values = (fields[field] as string).split(",").map((entry) => entry.trim());
    if (
      values.some(
        (entry) =>
          !/^-?\d+$/.test(entry) || !Number.isSafeInteger(Number(entry)) || Number(entry) === 0,
      )
    )
      throw new Error(`Invalid ${field}`);
    return values.map(Number);
  }
  const chatIds = ids("TELEGRAM_TEST_CHAT_ID");
  const allowedUsers = ids("TELEGRAM_TEST_ALLOWED_USERS");
  const allowedChats = ids("TELEGRAM_TEST_ALLOWED_CHATS");
  const chatId = chatIds[0];
  if (chatIds.length !== 1 || chatId === undefined || !allowedChats.includes(chatId))
    throw new Error("Invalid TELEGRAM_TEST_CHAT_ID");
  return {
    token,
    chatId,
    allowedUsers,
    allowedChats,
  };
}

export function isolatedTelegramFixturePath(worktree: string): string {
  let common: string;
  try {
    common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("Cannot resolve Telegram TEST repository");
  }
  return join(common, "spur-telegram-test", "credentials.json");
}

export function loadIsolatedTelegram(
  worktree: string,
  seed?: string,
  configuredTokens: readonly string[] = [],
): IsolatedTelegramCredentials | undefined {
  const path = isolatedTelegramFixturePath(worktree);
  const directory = join(path, "..");
  const seeded = seed === undefined ? undefined : validate(seed);
  if (seeded && configuredTokens.includes(seeded.token))
    throw new Error("Telegram TEST token matches a configured Telegram source");
  if (seeded) privateDirectory(directory);
  else {
    try {
      privatePath(directory, true);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  if (seed !== undefined) {
    try {
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, seed, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
        throw new Error("Cannot save Telegram TEST fixture", { cause: error });
    }
  }
  try {
    privatePath(path, false);
  } catch (error) {
    if (!seeded && error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let credentials: IsolatedTelegramCredentials;
  try {
    const stat = fstatSync(fd);
    if (stat.uid !== process.getuid?.() || !stat.isFile() || (stat.mode & 0o777) !== 0o600)
      throw new Error("Unsafe Telegram TEST fixture");
    credentials = validate(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
  if (seeded && JSON.stringify(seeded) !== JSON.stringify(credentials))
    throw new Error("Telegram TEST fixture already contains different credentials");
  if (configuredTokens.includes(credentials.token))
    throw new Error("Telegram TEST token matches a configured Telegram source");
  return credentials;
}

export function isolatedTelegramLockPath(credentials: IsolatedTelegramCredentials): string {
  const directory = join(tmpdir(), `spur-telegram-test-${process.getuid?.()}`);
  privateDirectory(directory);
  const path = join(
    directory,
    `${createHash("sha256").update(credentials.token).digest("hex")}.lock`,
  );
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  privatePath(path, false);
  return path;
}

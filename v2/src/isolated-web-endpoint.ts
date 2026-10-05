import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDefaultInstanceConfigPath } from "./config.js";
import { readLiveProcessStarttime } from "./sidecars/reap.js";

interface UiEndpoint {
  version: 1;
  configPath: string;
  port: number;
  pid: number;
  starttime: number;
}

async function ownEndpointPath(configPath: string, filePath: string): Promise<string> {
  if (!isAbsolute(configPath) || !isAbsolute(filePath) || isDefaultInstanceConfigPath(configPath))
    throw new Error("Invalid isolated UI instance");
  const canonical = await realpath(configPath);
  const directory = dirname(canonical);
  const directoryStat = await lstat(directory);
  const configStat = await lstat(configPath);
  const uid = process.getuid?.();
  if (
    canonical !== resolve(configPath) ||
    (await realpath(directory)) !== directory ||
    !directoryStat.isDirectory() ||
    directoryStat.uid !== uid ||
    (directoryStat.mode & 0o777) !== 0o700 ||
    !configStat.isFile() ||
    configStat.isSymbolicLink() ||
    configStat.uid !== uid ||
    filePath !== join(directory, "ui-endpoint.json")
  )
    throw new Error("Unsafe isolated UI instance");
  return canonical;
}

function isPrivateFile(stat: Stats): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o777) === 0o600 &&
    stat.nlink === 1
  );
}

function isUiEndpoint(value: unknown): value is UiEndpoint {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 5 &&
    record["version"] === 1 &&
    typeof record["configPath"] === "string" &&
    typeof record["port"] === "number" &&
    Number.isInteger(record["port"]) &&
    record["port"] > 0 &&
    record["port"] <= 65535 &&
    typeof record["pid"] === "number" &&
    Number.isSafeInteger(record["pid"]) &&
    record["pid"] > 0 &&
    typeof record["starttime"] === "number" &&
    Number.isSafeInteger(record["starttime"]) &&
    record["starttime"] >= 0
  );
}

export async function publishIsolatedWebEndpoint(args: {
  configPath: string;
  filePath: string;
  port: number;
  pid: number;
}): Promise<void> {
  const configPath = await ownEndpointPath(args.configPath, args.filePath);
  try {
    if (!isPrivateFile(await lstat(args.filePath))) throw new Error("Unsafe isolated UI receipt");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const starttime = await readLiveProcessStarttime(args.pid);
  const endpoint = { version: 1, configPath, port: args.port, pid: args.pid, starttime };
  if (!isUiEndpoint(endpoint)) throw new Error("Invalid isolated UI live owner or port");
  // Only this publisher's temporary path is cleaned; never unlink shared receipt.
  const temporary = `${args.filePath}.${process.pid}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(endpoint));
    await file.close();
    await rename(temporary, args.filePath);
  } finally {
    await file.close();
    await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}

export async function readIsolatedWebEndpoint(
  configPath: string,
  filePath: string,
): Promise<string | null> {
  try {
    const canonical = await ownEndpointPath(configPath, filePath);
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: unknown;
    try {
      const stat = await file.stat();
      if (!isPrivateFile(stat)) return null;
      try {
        value = JSON.parse(await file.readFile("utf8"));
      } catch {
        return null;
      }
    } finally {
      await file.close();
    }
    if (
      !isUiEndpoint(value) ||
      value.configPath !== canonical ||
      (await readLiveProcessStarttime(value.pid)) !== value.starttime
    )
      return null;
    return `http://127.0.0.1:${value.port}`;
  } catch {
    return null;
  }
}

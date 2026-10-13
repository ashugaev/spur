import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDefaultInstanceConfigPath, loadInstanceConfigReadOnly } from "./config.js";
import { readLiveProcessStarttime } from "./sidecars/reap.js";
import { SPUR_DAEMON_API_VERSION } from "./types.js";

interface UiEndpoint {
  version: 1;
  configPath: string;
  port: number;
  pid: number;
  starttime: number;
}

export interface IsolatedDaemonCandidate {
  configPath: string;
  filePath: string;
  dataDir: string;
  baseUrl: string;
  socketName: string;
  pid: number;
  starttime: number;
}

export async function captureIsolatedDaemonStarttime(pid: number): Promise<number | null> {
  return Number.isSafeInteger(pid) && pid > 0 ? readLiveProcessStarttime(pid) : null;
}

export async function validateIsolatedDaemonReady(
  candidate: IsolatedDaemonCandidate,
  expectedLifecycleInstanceId?: string,
): Promise<string | null> {
  try {
    const canonical = await ownEndpointPath(candidate.configPath, candidate.filePath);
    if (
      !Number.isSafeInteger(candidate.starttime) ||
      candidate.starttime < 0 ||
      (await captureIsolatedDaemonStarttime(candidate.pid)) !== candidate.starttime
    )
      return null;
    const loaded = loadInstanceConfigReadOnly(canonical);
    if (loaded.status !== "ok") return null;
    const config = loaded.config;
    if (
      config.server.host !== "127.0.0.1" ||
      config.server.port > 65535 ||
      candidate.baseUrl !== `http://127.0.0.1:${config.server.port}` ||
      config.dataDir !== join(dirname(canonical), "data") ||
      candidate.dataDir !== config.dataDir ||
      candidate.socketName !== config.tmux.socketName
    )
      return null;
    const response = await fetch(`${candidate.baseUrl}/info`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    if (typeof payload !== "object" || payload === null) return null;
    const info = payload as Record<string, unknown>;
    if (
      info["ok"] !== true ||
      info["apiVersion"] !== SPUR_DAEMON_API_VERSION ||
      info["pid"] !== candidate.pid ||
      info["host"] !== config.server.host ||
      info["port"] !== config.server.port ||
      info["configPath"] !== canonical ||
      info["dataDir"] !== candidate.dataDir ||
      info["tmuxSocketName"] !== candidate.socketName ||
      typeof info["lifecycleInstanceId"] !== "string" ||
      !info["lifecycleInstanceId"].trim() ||
      (expectedLifecycleInstanceId !== undefined &&
        info["lifecycleInstanceId"] !== expectedLifecycleInstanceId) ||
      (await captureIsolatedDaemonStarttime(candidate.pid)) !== candidate.starttime
    )
      return null;
    return info["lifecycleInstanceId"];
  } catch {
    return null;
  }
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

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { chmod, link, lstat, open, rename, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  isCompatibleRuntimeInfo,
  type RestartDaemonResult,
  type StopDaemonResult,
} from "./client.js";
import { assertConfigMayUseProdSlot } from "./config.js";
import { collectTree, snapshotProcesses } from "./sidecars/reap.js";
import {
  captureIsolatedDaemonStarttime,
  loadIsolatedDaemonConfig,
  ownEndpointPath,
  readIsolatedDaemonReady,
} from "./isolated-web-endpoint.js";

interface Identity {
  pid: number;
  starttime: number;
}
interface DaemonIdentity extends Identity {
  lifecycleInstanceId: string;
}
interface OwnerRecord {
  version: 1;
  configPath: string;
  controlPath: string;
  owner: Identity;
  daemon: DaemonIdentity | null;
}
type Request =
  | { version: 1; operation: "restart"; owner: Identity; daemon: DaemonIdentity }
  | { version: 1; operation: "stop"; owner: Identity };
type Response =
  | { ok: true; result: RestartDaemonResult | StopDaemonResult }
  | { ok: false; error: { code: ErrorCode; message: string } };

const ERROR_CODES = [
  "invalid_request",
  "owner_mismatch",
  "generation_mismatch",
  "busy",
  "stopping",
  "start_failed",
  "stop_failed",
] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

const COMPLETION_MS = 45_000;
const REQUEST_BYTES = 4096;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}
function identity(value: unknown, daemon = false): value is DaemonIdentity {
  return (
    object(value) &&
    keys(value, daemon ? ["pid", "starttime", "lifecycleInstanceId"] : ["pid", "starttime"]) &&
    typeof value["pid"] === "number" &&
    Number.isSafeInteger(value["pid"]) &&
    value["pid"] > 0 &&
    typeof value["starttime"] === "number" &&
    Number.isSafeInteger(value["starttime"]) &&
    value["starttime"] >= 0 &&
    (!daemon ||
      (typeof value["lifecycleInstanceId"] === "string" &&
        value["lifecycleInstanceId"].trim().length > 0))
  );
}
function request(value: unknown): value is Request {
  return (
    object(value) &&
    value["version"] === 1 &&
    identity(value["owner"]) &&
    ((value["operation"] === "stop" && keys(value, ["version", "operation", "owner"])) ||
      (value["operation"] === "restart" &&
        keys(value, ["version", "operation", "owner", "daemon"]) &&
        identity(value["daemon"], true)))
  );
}
function operationResult(
  value: unknown,
  operation: "restart" | "stop",
): value is RestartDaemonResult | StopDaemonResult {
  if (!object(value) || typeof value["baseUrl"] !== "string") return false;
  const kind = operation === "restart" ? "restarted" : "stopped";
  const pidKey = operation === "restart" ? "previousPid" : "pid";
  const expected = ["baseUrl", kind];
  if (pidKey in value) {
    const pid = value[pidKey];
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
    expected.push(pidKey);
  }
  if (operation === "restart" && "runtime" in value) {
    if (!isCompatibleRuntimeInfo(value["runtime"])) return false;
    expected.push("runtime");
  }
  return typeof value[kind] === "boolean" && keys(value, expected);
}
function same(a: Identity, b: Identity): boolean {
  return a.pid === b.pid && a.starttime === b.starttime;
}
function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}
async function live(value: Identity): Promise<boolean> {
  return (await captureIsolatedDaemonStarttime(value.pid)) === value.starttime;
}
function failure(code: ErrorCode, message: string): Response {
  return { ok: false, error: { code, message } };
}
function frame(socket: Socket, limit?: number, begin?: Promise<void>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const start = (): void => {
      if (!settled)
        timer = setTimeout(() => fail(new Error("Incomplete control frame")), COMPLETION_MS);
    };
    if (begin) void begin.then(start);
    else start();
    function cleanup(): void {
      clearTimeout(timer);
      settled = true;
      socket.off("data", data);
      socket.off("end", end);
      socket.off("error", fail);
      socket.off("close", close);
    }
    function fail(error: Error): void {
      cleanup();
      reject(error);
    }
    function close(): void {
      fail(new Error("Control transport closed"));
    }
    function data(chunk: Buffer): void {
      length += chunk.length;
      if (limit !== undefined && length > limit) {
        fail(new Error("Control request too long"));
        return;
      }
      chunks.push(chunk);
    }
    function end(): void {
      cleanup();
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length === 0 ||
        bytes[bytes.length - 1] !== 10 ||
        bytes.subarray(0, -1).includes(10)
      ) {
        reject(new Error("Expected one JSON line and EOF"));
        return;
      }
      try {
        resolve(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)),
          ) as unknown,
        );
      } catch {
        reject(new Error("Invalid control JSON"));
      }
    }
    socket.on("data", data);
    socket.once("end", end);
    socket.once("error", fail);
    socket.once("close", close);
  });
}
async function privateFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error("Unsafe isolated owner record");
}
interface FileIdentity {
  dev: number;
  ino: number;
  contents: string;
}
async function checkPublication(path: string, expected: FileIdentity): Promise<void> {
  await privateFile(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.size !== Buffer.byteLength(expected.contents) ||
      (await file.readFile("utf8")) !== expected.contents
    )
      throw new Error("Isolated publication changed owner");
  } finally {
    await file.close();
  }
}
async function writePrivate(
  path: string,
  contents: string,
  allowed = (): boolean => true,
  expected?: FileIdentity,
): Promise<FileIdentity> {
  async function check(): Promise<void> {
    try {
      if (expected) await checkPublication(path, expected);
      else {
        await lstat(path);
        throw new Error("Isolated publication changed owner");
      }
    } catch (error) {
      if (!(object(error) && error["code"] === "ENOENT" && expected === undefined)) throw error;
    }
  }
  await check();
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(contents);
    await file.close();
    await check();
    if (!allowed()) throw new Error("Owner stopping");
    if (expected) await rename(temporary, path);
    else await link(temporary, path);
    const stat = await lstat(path);
    return { dev: stat.dev, ino: stat.ino, contents };
  } finally {
    await file.close();
    await unlink(temporary).catch((error: unknown) => {
      if (!(object(error) && error["code"] === "ENOENT")) throw error;
    });
  }
}

export interface IsolatedOwnerOptions {
  configPath: string;
  cliPath: string;
  runtimePath: string;
  projectConfigPath: string;
  sourceWorktree: string;
}
class DaemonStopBlocked extends Error {}

export async function serveIsolatedDaemon(options: IsolatedOwnerOptions): Promise<void> {
  const { configPath, config } = await loadIsolatedDaemonConfig(options.configPath);
  assertConfigMayUseProdSlot(configPath);
  const directory = dirname(configPath);
  const controlPath = join(directory, "owner.sock");
  const recordPath = join(directory, "owner.json");
  const starttime = await captureIsolatedDaemonStarttime(process.pid);
  if (starttime === null) throw new Error("Unavailable owner identity");
  const record: OwnerRecord = {
    version: 1,
    configPath,
    controlPath,
    owner: { pid: process.pid, starttime },
    daemon: null,
  };
  const baseUrl = `http://127.0.0.1:${config.server.port}`;
  let child: ChildProcess | null = null;
  const childRunning = (): boolean => child !== null && running(child);
  let childIdentityReady: Promise<Identity | null> = Promise.resolve(null);
  let childGeneration: DaemonIdentity | null = null;
  let restartBlocked = false;
  const state = { terminal: false, restarting: false };
  const stopping = (): boolean => state.terminal;
  let expectedExit = false;
  let terminalPromise: Promise<StopDaemonResult> | undefined;
  let readyPublication: Promise<void> = Promise.resolve();
  let runtimeReceipt: FileIdentity | undefined;
  let recordReceipt: FileIdentity | undefined;
  const incomplete = new Set<Socket>();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let publication: Promise<void> = Promise.resolve();
  const publish = (): Promise<void> => {
    const snapshot = JSON.stringify(record);
    const ready = record.daemon !== null;
    const next = publication
      .catch(() => undefined)
      .then(async () => {
        recordReceipt = await writePrivate(
          recordPath,
          snapshot,
          () => !ready || !state.terminal,
          recordReceipt,
        );
      });
    publication = next;
    return next;
  };
  async function withdrawRuntime(): Promise<void> {
    if (!runtimeReceipt) return;
    try {
      await checkPublication(options.runtimePath, runtimeReceipt);
      await unlink(options.runtimePath);
      runtimeReceipt = undefined;
    } catch (error) {
      if (!(object(error) && error["code"] === "ENOENT")) throw error;
    }
  }
  let childStop: Promise<void> | undefined;
  function stopChild(): Promise<void> {
    if (childStop) return childStop;
    childStop = finishChildStop();
    return childStop.finally(() => {
      childStop = undefined;
    });
  }
  async function finishChildStop(): Promise<void> {
    const owned = child;
    if (!owned) return;
    expectedExit = true;
    const ownedIdentity = await childIdentityReady;
    const ownedPid = owned.pid;
    async function inventory(): Promise<number[] | null> {
      if (ownedPid === undefined) return null;
      const snapshot = await snapshotProcesses();
      if (!snapshot.ok || snapshot.byPid.get(ownedPid)?.ppid !== record.owner.pid) return null;
      return collectTree(ownedPid, snapshot).filter((pid) => pid !== ownedPid);
    }
    const descendants = stopping() ? await inventory() : [];
    if (running(owned)) {
      if (!ownedIdentity || !(await live(ownedIdentity)))
        throw new DaemonStopBlocked("Cannot confirm daemon identity");
      owned.kill("SIGTERM");
      for (let attempt = 0; attempt < 20 && running(owned); attempt++) await delay(100);
      if (running(owned)) {
        if (!stopping()) throw new DaemonStopBlocked("Restart stop unconfirmed");
        const generation = childGeneration;
        const currentDescendants = await inventory();
        const runtime =
          generation &&
          (await readIsolatedDaemonReady(
            {
              configPath,
              filePath: join(directory, "ui-endpoint.json"),
              dataDir: config.dataDir,
              baseUrl,
              socketName: config.tmux.socketName,
              ...generation,
            },
            generation.lifecycleInstanceId,
          ));
        if (
          !generation ||
          !runtime ||
          runtime.lifecycleInstanceId !== generation.lifecycleInstanceId ||
          child !== owned ||
          childGeneration !== generation ||
          !same(generation, ownedIdentity) ||
          currentDescendants === null ||
          currentDescendants.length !== 0 ||
          descendants === null ||
          descendants.length !== 0 ||
          !recordReceipt ||
          !(await live(record.owner))
        )
          throw new DaemonStopBlocked("Terminal ownership or descendants unconfirmed");
        await checkPublication(recordPath, recordReceipt);
        if (!(await live(ownedIdentity)) || child !== owned || childGeneration !== generation)
          throw new DaemonStopBlocked("Terminal daemon identity changed");
        const finalDescendants = await inventory();
        if (finalDescendants === null || finalDescendants.length !== 0 || !running(owned))
          throw new DaemonStopBlocked("Terminal descendants changed");
        if (!owned.kill("SIGKILL")) throw new DaemonStopBlocked("Terminal signal unconfirmed");
        for (let attempt = 0; attempt < 20 && running(owned); attempt++) await delay(100);
        if (running(owned)) throw new DaemonStopBlocked("Terminal exit unconfirmed");
      }
    }
    if (
      stopping() &&
      (descendants === null ||
        (await Promise.all(descendants.map(captureIsolatedDaemonStarttime))).some(
          (starttime) => starttime !== null,
        ))
    )
      throw new DaemonStopBlocked("Owned descendant teardown unconfirmed");
    if (child === owned) {
      child = null;
    }
  }
  async function start(
    previousLifecycle?: string,
  ): Promise<NonNullable<RestartDaemonResult["runtime"]>> {
    if (stopping()) throw new Error("Owner stopping");
    expectedExit = false;
    const owned = spawn(
      process.execPath,
      [options.cliPath, "--config", configPath, "daemon", "start"],
      { detached: false, stdio: "inherit" },
    );
    child = owned;
    childGeneration = null;
    owned.once("error", () => {
      if (!state.terminal) void stop().catch(() => undefined);
    });
    owned.once("exit", () => {
      if ((!expectedExit || restartBlocked) && !state.terminal) void stop().catch(() => undefined);
    });
    if (!owned.pid) throw new Error("Daemon did not spawn");
    const pid = owned.pid;
    childIdentityReady = captureIsolatedDaemonStarttime(owned.pid).then((value) => {
      return value === null ? null : { pid, starttime: value };
    });
    const childIdentity = await childIdentityReady;
    if (childIdentity === null) throw new Error("Daemon identity unavailable");
    const childStart = childIdentity.starttime;
    const deadline = performance.now() + 40_000;
    while (performance.now() < deadline) {
      if (stopping() || child !== owned || !running(owned))
        throw new Error("Daemon exited before readiness");
      const runtime = await readIsolatedDaemonReady({
        configPath,
        filePath: join(directory, "ui-endpoint.json"),
        dataDir: config.dataDir,
        baseUrl,
        socketName: config.tmux.socketName,
        ...childIdentity,
      });
      if (runtime && runtime.lifecycleInstanceId !== previousLifecycle) {
        const generationLive = await live(childIdentity);
        if (stopping() || child !== owned || !generationLive) throw new Error("Owner stopping");
        childGeneration = { ...childIdentity, lifecycleInstanceId: runtime.lifecycleInstanceId };
        readyPublication = (async () => {
          const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
          try {
            await lstat(options.runtimePath);
            throw new Error("Foreign isolated ready snapshot");
          } catch (error) {
            if (!(object(error) && error["code"] === "ENOENT")) throw error;
          }
          runtimeReceipt = await writePrivate(
            options.runtimePath,
            Object.entries({
              SPUR_ISOLATED_CONFIG: configPath,
              SPUR_ISOLATED_UI_ENDPOINT_FILE: join(directory, "ui-endpoint.json"),
              SPUR_ISOLATED_DATA_DIR: config.dataDir,
              SPUR_ISOLATED_DAEMON_URL: baseUrl,
              SPUR_ISOLATED_TMUX_SOCKET_NAME: config.tmux.socketName,
              SPUR_ISOLATED_PROJECT_CONFIG: options.projectConfigPath,
              SPUR_ISOLATED_SOURCE_WORKTREE: options.sourceWorktree,
              SPUR_ISOLATED_DAEMON_PID: String(owned.pid),
              SPUR_ISOLATED_DAEMON_STARTTIME: String(childStart),
            })
              .map(([key, value]) => `${key}=${quote(value)}\n`)
              .join(""),
            () => !state.terminal && child === owned,
          );
          if (stopping()) throw new Error("Owner stopping");
          record.daemon = { ...childIdentity, lifecycleInstanceId: runtime.lifecycleInstanceId };
          await publish();
        })();
        await readyPublication;
        if (stopping()) throw new Error("Owner stopping");
        return runtime;
      }
      await delay(Math.min(250, Math.max(0, deadline - performance.now())));
    }
    throw new Error("Daemon readiness unconfirmed");
  }
  function stop(): Promise<StopDaemonResult> {
    state.terminal = true;
    if (terminalPromise) return terminalPromise;
    const pid = child?.pid;
    server.close();
    for (const socket of incomplete) socket.destroy();
    terminalPromise = (async () => {
      await readyPublication.catch(() => undefined);
      record.daemon = null;
      let withdrawalError: unknown;
      try {
        await withdrawRuntime();
      } catch (error) {
        withdrawalError = error;
      }
      try {
        await publish();
      } catch (error) {
        withdrawalError ??= error;
      }
      await stopChild();
      if (withdrawalError !== undefined)
        throw withdrawalError instanceof Error
          ? withdrawalError
          : new Error("Ready snapshot withdrawal failed");
      return { baseUrl, ...(pid === undefined ? {} : { pid }), stopped: true };
    })();
    void terminalPromise.then(finish, () => {
      const owned = child;
      if (!owned || !running(owned)) finish();
      else owned.once("exit", finish);
    });
    return terminalPromise;
  }
  async function act(value: unknown): Promise<Response> {
    if (!request(value)) return failure("invalid_request", "Invalid owner request");
    if (!same(value.owner, record.owner) || !(await live(record.owner)))
      return failure("owner_mismatch", "Owner identity changed");
    if (value.operation === "stop") {
      try {
        return { ok: true, result: await stop() };
      } catch {
        return failure("stop_failed", "Daemon stop unconfirmed");
      }
    }
    const generation = record.daemon;
    const generationLive = generation !== null && (await live(generation));
    if (stopping()) return failure("stopping", "Owner stopping");
    if (restartBlocked) return failure("stop_failed", "Previous restart stop remains unconfirmed");
    if (state.restarting) return failure("busy", "Restart in progress");
    if (
      !generation ||
      record.daemon !== generation ||
      !same(value.daemon, generation) ||
      value.daemon.lifecycleInstanceId !== generation.lifecycleInstanceId ||
      !generationLive
    )
      return failure("generation_mismatch", "Daemon generation changed");
    state.restarting = true;
    const previous = record.daemon;
    record.daemon = null;
    try {
      await withdrawRuntime();
      await publish();
      await stopChild();
      const runtime = await start(previous.lifecycleInstanceId);
      return { ok: true, result: { baseUrl, previousPid: previous.pid, restarted: true, runtime } };
    } catch (error) {
      if (error instanceof DaemonStopBlocked && !stopping()) {
        restartBlocked = true;
        return failure("stop_failed", "Restart stop unconfirmed; owner retained");
      }
      const wasStopping = stopping();
      await stop().catch(() => undefined);
      return failure(wasStopping ? "stopping" : "start_failed", "Replacement daemon unconfirmed");
    } finally {
      state.restarting = false;
    }
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => socket.destroy());
    incomplete.add(socket);
    void frame(socket, REQUEST_BYTES)
      .then(
        (value) => {
          incomplete.delete(socket);
          return act(value);
        },
        () => {
          incomplete.delete(socket);
          return failure("invalid_request", "Invalid control frame");
        },
      )
      .then((response) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
      });
  });
  const terminate = (): void => {
    void stop().catch(() => undefined);
  };
  let socketIdentity: { dev: number; ino: number } | undefined;
  async function cleanupSocket(): Promise<void> {
    try {
      const stat = await lstat(controlPath);
      if (socketIdentity && socketIdentity.dev === stat.dev && socketIdentity.ino === stat.ino)
        await unlink(controlPath);
    } catch (error) {
      if (!(object(error) && error["code"] === "ENOENT")) throw error;
    }
  }
  process.on("SIGTERM", terminate);
  process.on("SIGINT", terminate);
  try {
    // Bind exclusively: an existing socket, including a stale one, is never removed.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(controlPath, resolve);
    });
    await chmod(controlPath, 0o600);
    const socketStat = await lstat(controlPath);
    socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
    await publish();
    await start();
    await finished;
    await terminalPromise;
  } finally {
    await stop().catch(() => undefined);
    if (childRunning()) await finished;
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
    await cleanupSocket();
  }
}

export async function requestIsolatedDaemon(
  configPath: string,
  operation: "restart" | "stop",
): Promise<RestartDaemonResult | StopDaemonResult> {
  const uid = process.getuid?.();
  const canonical = await ownEndpointPath(
    configPath,
    join(dirname(configPath), "ui-endpoint.json"),
  );
  const recordPath = join(dirname(canonical), "owner.json");
  await privateFile(recordPath);
  const file = await open(
    recordPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let value: unknown;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600)
      throw new Error("Unsafe owner record descriptor");
    try {
      value = JSON.parse(await file.readFile("utf8")) as unknown;
    } catch {
      throw new Error("Invalid owner record");
    }
  } finally {
    await file.close();
  }
  if (
    !object(value) ||
    !keys(value, ["version", "configPath", "controlPath", "owner", "daemon"]) ||
    value["version"] !== 1 ||
    value["configPath"] !== canonical ||
    value["controlPath"] !== join(dirname(canonical), "owner.sock") ||
    !identity(value["owner"]) ||
    !(await live(value["owner"])) ||
    (value["daemon"] !== null && !identity(value["daemon"], true))
  )
    throw new Error("Unavailable isolated owner");
  const socketStat = await lstat(value["controlPath"]);
  if (
    !socketStat.isSocket() ||
    socketStat.uid !== uid ||
    (socketStat.mode & 0o777) !== 0o600 ||
    socketStat.nlink !== 1
  )
    throw new Error("Unsafe owner socket");
  if (operation === "restart" && value["daemon"] === null)
    throw new Error("Isolated daemon not ready");
  const message =
    operation === "restart"
      ? { version: 1, operation, owner: value["owner"], daemon: value["daemon"] }
      : { version: 1, operation, owner: value["owner"] };
  const socket = createConnection({ path: value["controlPath"], allowHalfOpen: true });
  let sent!: () => void;
  const halfClosed = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const connectionTimer = setTimeout(
    () => socket.destroy(new Error("Owner connection timed out")),
    COMPLETION_MS,
  );
  let result: unknown;
  let confirmedError: Error | undefined;
  try {
    const response = frame(socket, undefined, halfClosed);
    socket.once("connect", () => {
      clearTimeout(connectionTimer);
      socket.end(`${JSON.stringify(message)}\n`, sent);
    });
    result = await response;
    if (!object(result) || typeof result["ok"] !== "boolean")
      throw new Error("Invalid owner response");
    if (
      result["ok"] === false &&
      keys(result, ["ok", "error"]) &&
      object(result["error"]) &&
      keys(result["error"], ["code", "message"]) &&
      typeof result["error"]["code"] === "string" &&
      ERROR_CODES.some(
        (code) => object(result) && object(result["error"]) && code === result["error"]["code"],
      ) &&
      typeof result["error"]["message"] === "string"
    ) {
      confirmedError = new Error(`${result["error"]["code"]}: ${result["error"]["message"]}`);
    } else {
      if (
        result["ok"] !== true ||
        !keys(result, ["ok", "result"]) ||
        !operationResult(result["result"], operation)
      )
        throw new Error("Invalid owner response");
      return result["result"];
    }
  } catch {
    throw new Error("UNCONFIRMED: isolated control outcome; reconcile owner state without replay");
  } finally {
    clearTimeout(connectionTimer);
    socket.destroy();
  }
  throw confirmedError;
}

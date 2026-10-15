import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { projectConfigSource } from "./config.js";
import { integer, object, string, ReviewAppError } from "./github-app.js";
import { expandReceiptPath, receiptHash, type ReviewLane } from "./review-receipt.js";
import { readProcStarttime } from "./sidecars/reap.js";
import type { AppConfig } from "./types.js";

export interface CallerBootstrapRequest {
  projectId: string;
  sourceId: string;
  triggerId: string;
  blockIndex: number;
  repository: string;
  pr: number;
  prompt: string;
}

export interface CallerPin {
  file: string;
  digest: string;
}
export interface CallerSourceSnapshot {
  kind: "configured-source";
  generation: number;
  projectId: string;
  sourceId: string;
  triggerId: string;
  config: CallerPin;
  effectiveDigest: string;
  blocks: Record<ReviewLane, number>;
  runtime: CallerPin;
  modules: CallerPin[];
}
export interface ConfiguredCallerBootstrap {
  config: CallerPin;
  effectiveDigest: string;
  projectId: string;
  sourceId: string;
  triggerId: string;
  blockIndex: number;
  repository: string;
  pr: number;
  promptDigest: string;
}
export interface CallerReadback {
  version: string;
  processes: { pid: number; identity: string }[];
  statusDigest: string;
}
function blockIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ReviewAppError("caller-source-invalid");
  return value;
}
export function parseConfiguredCallerBootstrap(value: unknown): ConfiguredCallerBootstrap {
  const row = object(value);
  const config = object(row.config);
  return {
    config: { file: string(config.file), digest: receiptHash(config.digest, 64) },
    effectiveDigest: receiptHash(row.effectiveDigest, 64),
    projectId: string(row.projectId),
    sourceId: string(row.sourceId),
    triggerId: string(row.triggerId),
    blockIndex: blockIndex(row.blockIndex),
    repository: string(row.repository),
    pr: integer(row.pr),
    promptDigest: receiptHash(row.promptDigest, 64),
  };
}
export async function captureConfiguredCaller(
  config: AppConfig,
  request: CallerBootstrapRequest,
): Promise<ConfiguredCallerBootstrap | null> {
  const project = config.projects[request.projectId];
  const source = project && projectConfigSource(project);
  const trigger = project?.triggers[request.triggerId];
  if (
    !source ||
    !trigger ||
    !("spawn" in trigger) ||
    trigger.source !== request.sourceId ||
    !trigger.spawn.blocks[request.blockIndex]
  )
    return null;
  const bytes = await readFile(source.file);
  if (createHash("sha256").update(bytes).digest("hex") !== source.digest) return null;
  return {
    config: source,
    effectiveDigest: createHash("sha256")
      .update(JSON.stringify({ source: project.sources[trigger.source], trigger }))
      .digest("hex"),
    projectId: request.projectId,
    sourceId: request.sourceId,
    triggerId: request.triggerId,
    blockIndex: request.blockIndex,
    repository: request.repository,
    pr: request.pr,
    promptDigest: createHash("sha256").update(request.prompt).digest("hex"),
  };
}
export function parseCallerSourceSnapshot(value: unknown): CallerSourceSnapshot {
  const row = object(value);
  if (row.kind !== "configured-source" || !Array.isArray(row.modules) || !row.modules.length)
    throw new ReviewAppError("caller-source-invalid");
  const pin = (value: unknown): CallerPin => {
    const row = object(value);
    return { file: string(row.file), digest: receiptHash(row.digest, 64) };
  };
  const blocks = object(row.blocks);
  const code = blockIndex(blocks.code),
    browser = blockIndex(blocks.browser);
  if (code === browser) throw new ReviewAppError("caller-source-invalid");
  return {
    kind: "configured-source",
    generation: integer(row.generation),
    projectId: string(row.projectId),
    sourceId: string(row.sourceId),
    triggerId: string(row.triggerId),
    config: pin(row.config),
    effectiveDigest: receiptHash(row.effectiveDigest, 64),
    blocks: { code, browser },
    runtime: pin(row.runtime),
    modules: row.modules.map(pin),
  };
}
export function callerSourceMatches(config: AppConfig, expected: CallerSourceSnapshot): boolean {
  const project = config.projects[expected.projectId];
  if (!project || !isDeepStrictEqual(projectConfigSource(project), expected.config)) return false;
  const trigger = project.triggers[expected.triggerId];
  if (!trigger || !("spawn" in trigger) || trigger.source !== expected.sourceId) return false;
  if (!trigger.spawn.blocks[expected.blocks.code] || !trigger.spawn.blocks[expected.blocks.browser])
    return false;
  const effective = { source: project.sources[trigger.source], trigger };
  return (
    createHash("sha256").update(JSON.stringify(effective)).digest("hex") ===
    expected.effectiveDigest
  );
}

// Only the controller calls this producer. HTTP ingress never supplies a result,
// PID or executable claim. Each result belongs to an owned ChildProcess handle.
export async function readConfiguredCaller(
  snapshot: CallerSourceSnapshot,
  tool: CallerPin,
  apps: CallerPin,
  repository: string,
  verify: (pin: CallerPin) => Promise<unknown>,
): Promise<CallerReadback> {
  const pins = [snapshot.config, snapshot.runtime, tool, apps, ...snapshot.modules];
  const check = async () => {
    for (const pin of pins) await verify(pin);
  };
  await check();
  const runtime = await realpath(expandReceiptPath(snapshot.runtime.file));
  const entry = await realpath(expandReceiptPath(tool.file));
  const appConfig = await realpath(expandReceiptPath(apps.file));
  const processes: CallerReadback["processes"] = [];
  const run = async (args: string[]): Promise<string> => {
    let resolveResult: (value: string) => void;
    let rejectResult: (error: unknown) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = execFile(
      runtime,
      [entry, ...args],
      {
        cwd: "/",
        env,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) rejectResult(error);
        else resolveResult(stdout);
      },
    );
    // Attach rejection handling before the first async process observation.
    const outcome = result.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      const pid = child.pid;
      const identity = pid === undefined ? null : await readProcStarttime(pid);
      if (pid === undefined || identity?.kind !== "ok")
        throw new ReviewAppError("caller-process-unavailable");
      const executable = await realpath(`/proc/${pid}/exe`);
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
      if (executable !== runtime || !isDeepStrictEqual(argv, [runtime, entry, ...args]))
        throw new ReviewAppError("caller-process-mismatch");
      const completed = await outcome;
      if ("error" in completed) throw new ReviewAppError("caller-readback-failed");
      processes.push({ pid, identity: String(identity.starttime) });
      return completed.value;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await outcome;
    }
  };
  const version = (await run(["--version"])).trim();
  if (!version) throw new ReviewAppError("caller-version-unavailable");
  const status = await run([
    "review-app",
    "status",
    "--app-config",
    appConfig,
    "--repo",
    repository,
    "--json",
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(status);
  } catch {
    throw new ReviewAppError("caller-status-invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !["code", "browser"].every((lane) =>
      parsed.some((value) => {
        const row = object(value);
        return row.lane === lane && row.status === "OK";
      }),
    )
  )
    throw new ReviewAppError("caller-status-invalid");
  await check();
  return { version, processes, statusDigest: createHash("sha256").update(status).digest("hex") };
}

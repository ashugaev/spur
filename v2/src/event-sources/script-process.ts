import { spawn } from "node:child_process";

const STDOUT_LIMIT = 1_048_576;
const STDERR_LIMIT = 2048;
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"];

// Script env: allowlist above + configured env + source-set SPUR_SOURCE_ID,
// SPUR_PROJECT_ID, SPUR_STATE_DIR (persistent 0700 source-state/script/<project>/<source>).
// stdin closed; stdout capped at 1 MiB, stderr tail at 2048 bytes. No shell.

export interface ScriptProcessRequest {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
}

export type ScriptProcessResult =
  | { status: "ok"; stdout: string; durationMs: number; stderrTail: string }
  | { status: "aborted" }
  | {
      status: "failed";
      reason: "spawn" | "exit" | "signal" | "timeout" | "output_limit";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      durationMs: number;
      stderrTail: string;
    };

export function runScriptProcess(request: ScriptProcessRequest): Promise<ScriptProcessResult> {
  if (request.signal.aborted) return Promise.resolve({ status: "aborted" });
  const startedAt = Date.now();
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const processEnv = { ...env, ...request.env };
  return new Promise((resolve) => {
    const child = spawn(request.command[0] as string, request.command.slice(1), {
      cwd: request.cwd,
      env: processEnv,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let reason: "spawn" | "timeout" | "output_limit" | undefined;
    let aborted = false;
    let stdoutBytes = 0;
    const stdout: Buffer[] = [];
    let stderrTail = Buffer.alloc(0);
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Process group already exited.
      }
    };
    const terminate = (): void => {
      killGroup();
      // Escaped descendants can retain pipe writers after the leader is killed.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const abort = (): void => {
      aborted = true;
      terminate();
    };
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      reason ??= "timeout";
      terminate();
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_LIMIT) {
        reason ??= "output_limit";
        terminate();
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_LIMIT);
    });
    child.once("error", () => {
      reason ??= "spawn";
    });
    // Kill descendants even when the leader exits before its inherited pipes close.
    child.once("exit", killGroup);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      killGroup();
      if (aborted) {
        resolve({ status: "aborted" });
        return;
      }
      const details = {
        durationMs: Date.now() - startedAt,
        stderrTail: stderrTail.toString("utf8"),
      };
      if (reason || signal || exitCode !== 0) {
        resolve({
          status: "failed",
          reason: reason ?? (signal ? "signal" : "exit"),
          exitCode,
          signal,
          ...details,
        });
      } else {
        resolve({ status: "ok", stdout: Buffer.concat(stdout).toString("utf8"), ...details });
      }
    });
    if (request.signal.aborted) abort();
  });
}

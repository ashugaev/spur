import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { codexCommand } from "./codex.js";

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_OUTPUT_MAX_BYTES = 64 * 1024;
const PROBE_INTERVAL_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function codexCredentialSource(codexHome: string): string {
  for (const name of ["auth.json", "auth_legacy.json"]) {
    try {
      const path = realpathSync(join(codexHome, name));
      const source = statSync(path);
      return `${path}\0${source.dev}\0${source.ino}\0${source.mtimeMs}`;
    } catch {
      // A keychain or absent auth file still gets the global probe bound.
    }
  }
  try {
    return realpathSync(codexHome);
  } catch {
    return resolve(codexHome);
  }
}

export function readCodexOrdinaryUsageAllowed(
  codexHome: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  return new Promise((resolveResult) => {
    let settled = false;
    let output = "";
    let stderrBytes = 0;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(codexCommand(), ["app-server"], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolveResult(null);
      return;
    }
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      resolveResult(value);
    };
    const abort = (): void => finish(null);
    const timeout = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      finish(null);
      return;
    }
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > PROBE_OUTPUT_MAX_BYTES) {
        finish(null);
        return;
      }
      while (output.includes("\n")) {
        const end = output.indexOf("\n");
        const line = output.slice(0, end);
        output = output.slice(end + 1);
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(message)) continue;
        if (message["id"] === 1 && isRecord(message["result"])) {
          try {
            child.stdin.write(
              `${JSON.stringify({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } })}\n`,
            );
          } catch {
            finish(null);
          }
        } else if (message["id"] === 2) {
          const result = message["result"];
          const permission = isRecord(result) ? result["ordinaryUsageAllowed"] : undefined;
          finish(typeof permission === "boolean" ? permission : null);
          return;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > PROBE_OUTPUT_MAX_BYTES) finish(null);
    });
    child.stdin.on("error", () => finish(null));
    try {
      child.stdin.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "spur", version: "1" } } })}\n`,
      );
    } catch {
      finish(null);
    }
  });
}

interface ProbeBucket {
  home: string;
  key: string;
  result: boolean | null;
  startedAt: number;
}

export class CodexRateLimitPoller {
  private readonly buckets = new Map<string, ProbeBucket>();
  private readonly requested = new Map<string, string>();
  private readonly pending: string[] = [];
  private readonly controller = new AbortController();
  // A process restart loses the prior probe time. Delay the first read long
  // enough that an earlier process cannot have started one in this window.
  private globalStartedAt = Date.now();
  private active = false;
  private timer: NodeJS.Timeout | null = null;

  permission(sessionId: string, home: string, limitObservedAtMs: number): boolean | null {
    const key = codexCredentialSource(home);
    this.requested.set(sessionId, key);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { home, key, result: null, startedAt: -Infinity };
      this.buckets.set(key, bucket);
    }
    if (bucket.result === true && bucket.startedAt > limitObservedAtMs) return true;
    if (
      !this.pending.includes(key) &&
      (bucket.startedAt <= limitObservedAtMs || Date.now() - bucket.startedAt >= PROBE_INTERVAL_MS)
    ) {
      this.pending.push(key);
    }
    this.schedule();
    return bucket.result === false && bucket.startedAt > limitObservedAtMs ? false : null;
  }

  prune(liveIds: ReadonlySet<string>): void {
    for (const sessionId of this.requested.keys()) {
      if (!liveIds.has(sessionId)) this.requested.delete(sessionId);
    }
    const retained = new Set(this.requested.values());
    for (const key of this.buckets.keys()) if (!retained.has(key)) this.buckets.delete(key);
  }

  dispose(): void {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.length = 0;
    this.buckets.clear();
    this.requested.clear();
  }

  private schedule(): void {
    if (this.controller.signal.aborted || this.active || this.pending.length === 0) return;
    const now = Date.now();
    const wait = Math.max(0, this.globalStartedAt + PROBE_INTERVAL_MS - now);
    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.schedule();
        }, wait);
        this.timer.unref();
      }
      return;
    }
    const key = this.pending.shift();
    if (!key) return;
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.schedule();
      return;
    }
    this.active = true;
    this.globalStartedAt = now;
    bucket.startedAt = now;
    void readCodexOrdinaryUsageAllowed(bucket.home, this.controller.signal).then((result) => {
      this.active = false;
      if (!this.controller.signal.aborted && codexCredentialSource(bucket.home) === key) {
        bucket.result = result;
      }
      this.schedule();
    });
  }
}

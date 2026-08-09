import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  formatCacheSizeGb,
  planCachePrune,
  prunableCandidates,
  type CachePlan,
} from "./cache-retention.js";
import { dimText } from "./cli-view.js";
import {
  DEFAULT_DISK_RETENTION,
  loadInstanceConfigReadOnly,
  type InstanceConfigReadResult,
} from "./config.js";
import { parseDfField } from "./disk-space.js";
import { listSessions } from "./metadata.js";
import { findListenerPids, isHostPortFree } from "./port-probe.js";
import { withTimeout } from "./promise-timeout.js";
import { isExistingFile, isInsideWorktreeDir, readConfigRegistryFile } from "./registry.js";
import {
  assembleSidecarSweepClaims,
  findLeakedSidecarTrees,
  snapshotProcesses,
  SWEEP_DETAIL_MAX_TREES,
} from "./sidecars/reap.js";
import type { AppConfig } from "./types.js";
import {
  NPM_PIN_SANITIZE_ENV_KEYS,
  ensureNpmPinFile,
  hasNvm,
  healNpmrcPrefixLine,
  npmGlobalPrefix,
  npmPinConfigPath,
} from "./npm-prefix.js";
import { isReleaseVersion } from "./releases-cache.js";
import {
  probe,
  probeHeadroom,
  probeInfo,
  readWebPort,
  resolveDaemonPortReadOnly,
  type ProbeReason,
  type ServiceId,
} from "./update-health.js";
import { getVersion } from "./version.js";

// C2: below this available-KB/free-inode floor, `data-dir-disk-space` reports
// an error — deliberately low so a normal dev/CI host's disk is never flagged.
const DISK_SPACE_MIN_FREE_KB = 5_120;
const DISK_SPACE_PROBE_TIMEOUT_MS = 2_000;
// Above this total (session shards plus the root-level global logs),
// `data-dir-log-bytes` warns. Post-sweep steady state projects to ~1-1.5GB,
// so 5GB is ~3x headroom on a healthy host.
const LOG_BYTES_WARN_KB = 5 * 1024 * 1024;
// `du -sk <dataDir>/sessions` on a healthy host completes in ~0.02s; `du -sk
// <dataDir>` (which also walks worktrees) can take 6+s, so the probe is
// scoped to `sessions` and given a generous but bounded timeout.
const LOG_BYTES_PROBE_TIMEOUT_MS = 5_000;
// A2: `node -e "require('node-pty')"` must never hang doctor on a wedged
// child process.
const NODE_PTY_PROBE_TIMEOUT_MS = 5_000;
const RSS_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export interface HostInstallCheck {
  id: string;
  ok: boolean;
  severity: "error" | "warn" | "info";
  detail: string;
  fix?: string;
}

export interface SystemdScope {
  kind: "user" | "system" | "missing";
  unitDir: string;
  ctl: string[];
  restartCmd: string;
}

function formatRssBytes(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < RSS_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = RSS_UNITS[unitIndex] ?? "B";
  return unitIndex === 0 ? `${bytes} ${unit}` : `${value.toFixed(1)} ${unit}`;
}

function renderSessionRss(sessions: Array<{ id: string; rssBytes: number }>): string {
  if (sessions.length === 0) return "";
  const lines = sessions.map((session) => `  ${session.id}: ${formatRssBytes(session.rssBytes)}`);
  return `\nMeasured RSS per live session:\n${lines.join("\n")}`;
}

function tryExec(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): string | undefined {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
    }).trim();
  } catch {
    return undefined;
  }
}

export function isActive(ctl: string[], unit: string): boolean {
  const [bin, ...args] = ctl;
  if (!bin) return false;
  return tryExec(bin, [...args, "is-active", unit]) === "active";
}

export function resolveSystemdScope(home: string): SystemdScope {
  const userUnitDir = join(home, ".config", "systemd", "user");
  if (existsSync(join(userUnitDir, "spur-daemon.service"))) {
    return {
      kind: "user",
      unitDir: userUnitDir,
      ctl: ["systemctl", "--user"],
      restartCmd: "systemctl --user restart",
    };
  }
  // Compare against the unfakeable account home (`userInfo().homedir`, which
  // ignores `$HOME`) rather than `homedir()` (which honors `$HOME`). System
  // units are host-global, not namespaced per `$HOME`, so a caller running
  // under a test's overridden `$HOME` — where `home` defaults to `homedir()`
  // and would otherwise trivially equal itself — must not spuriously pick up
  // a real system-wide install that belongs to a different invocation.
  // `userInfo()` does a passwd lookup and throws when the current uid has no
  // passwd entry (common in containers/CI); `resolveSystemdScope` is on the
  // hot path of both `doctor` and `update`, so that must not crash either —
  // fall back to `undefined`, which never matches `home` and therefore never
  // reports a false "system" scope.
  let accountHome: string | undefined;
  try {
    accountHome = userInfo().homedir;
  } catch {
    accountHome = undefined;
  }
  if (
    accountHome !== undefined &&
    home === accountHome &&
    existsSync("/etc/systemd/system/spur-daemon.service")
  ) {
    return {
      kind: "system",
      unitDir: "/etc/systemd/system",
      ctl: ["systemctl"],
      restartCmd: "sudo systemctl restart",
    };
  }
  return {
    kind: "missing",
    unitDir: userUnitDir,
    ctl: ["systemctl", "--user"],
    restartCmd: "systemctl --user restart",
  };
}

// F3: a real actionable PATH gap requires that this host actually npm-installed
// spur under `npmPrefix` — otherwise every dev checkout / alternate package
// manager host would false-flag as broken.
export function checkSpurOnPath(npmPrefix: string | undefined): HostInstallCheck {
  if (!npmPrefix) {
    return {
      id: "npm-bin-on-path",
      ok: true,
      severity: "info",
      detail: "skipped — npm prefix unavailable",
    };
  }
  const binDir = join(npmPrefix, "bin");
  if (!existsSync(join(binDir, "spur"))) {
    return {
      id: "npm-bin-on-path",
      ok: true,
      severity: "info",
      detail: `skipped — no npm-installed spur binary detected at ${binDir}`,
    };
  }
  const onPath = (process.env["PATH"] ?? "").split(delimiter).includes(binDir);
  // Severity is the check's static importance if it fails, not a flag that
  // flips with the outcome — the renderer decides whether to surface it at
  // all, based on `ok` (see `renderHostInstallChecks`).
  return {
    id: "npm-bin-on-path",
    ok: onPath,
    severity: "error",
    detail: onPath ? `${binDir} is on PATH` : `${binDir} is not on PATH`,
    ...(onPath ? {} : { fix: `add ${binDir} to PATH` }),
  };
}

// F4: presence-only checks for the two external binaries every spawn depends on.
function checkTmuxInstalled(): HostInstallCheck {
  const detail = tryExec("tmux", ["-V"]);
  return {
    id: "tmux-installed",
    ok: detail !== undefined,
    severity: "error",
    detail: detail ?? "tmux not found on PATH",
    ...(detail === undefined ? { fix: "install tmux" } : {}),
  };
}

function checkGitInstalled(): HostInstallCheck {
  const detail = tryExec("git", ["--version"]);
  return {
    id: "git-installed",
    ok: detail !== undefined,
    severity: "error",
    detail: detail ?? "git not found on PATH",
    ...(detail === undefined ? { fix: "install git" } : {}),
  };
}

interface EnginesField {
  node?: string;
}

function readEnginesNodeRange(): string | undefined {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(pkgUrl, "utf8")) as { engines?: EnginesField };
    return typeof parsed.engines?.node === "string" ? parsed.engines.node : undefined;
  } catch {
    return undefined;
  }
}

function parseVersionTuple(value: string): [number, number, number] {
  const parts = value.replace(/^v/, "").split(".");
  const major = Number.parseInt(parts[0] ?? "0", 10);
  const minor = Number.parseInt(parts[1] ?? "0", 10);
  const patch = Number.parseInt(parts[2] ?? "0", 10);
  return [
    Number.isNaN(major) ? 0 : major,
    Number.isNaN(minor) ? 0 : minor,
    Number.isNaN(patch) ? 0 : patch,
  ];
}

function compareTuples(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Scoped to the two range operators actually present in `engines.node` today
// (`^X.Y.Z` and `>=X`) — not a general semver-range parser.
function satisfiesClause(clause: string, current: [number, number, number]): boolean {
  const trimmed = clause.trim();
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (caret) {
    const major = Number.parseInt(caret[1] ?? "0", 10);
    const min: [number, number, number] = [
      major,
      Number.parseInt(caret[2] ?? "0", 10),
      Number.parseInt(caret[3] ?? "0", 10),
    ];
    const max: [number, number, number] = [major + 1, 0, 0];
    return compareTuples(current, min) >= 0 && compareTuples(current, max) < 0;
  }
  const gte = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
  if (gte) {
    const min: [number, number, number] = [
      Number.parseInt(gte[1] ?? "0", 10),
      Number.parseInt(gte[2] ?? "0", 10),
      Number.parseInt(gte[3] ?? "0", 10),
    ];
    return compareTuples(current, min) >= 0;
  }
  return false;
}

export function satisfiesNodeEngineRange(range: string, currentVersion: string): boolean {
  const current = parseVersionTuple(currentVersion);
  return range.split("||").some((clause) => satisfiesClause(clause, current));
}

function checkNodeVersion(): HostInstallCheck {
  const range = readEnginesNodeRange();
  if (!range) {
    return {
      id: "node-version",
      ok: true,
      severity: "info",
      detail: "skipped — could not read engines.node from package.json",
    };
  }
  const satisfied = satisfiesNodeEngineRange(range, process.version);
  // Static severity (see `checkSpurOnPath`): always "error" here — a passing
  // check simply never renders it.
  return {
    id: "node-version",
    ok: satisfied,
    severity: "error",
    detail: satisfied
      ? `node ${process.version} satisfies ${range}`
      : `node ${process.version} does not satisfy required range ${range}`,
    ...(satisfied ? {} : { fix: `install a Node version matching ${range}` }),
  };
}

export interface ServiceHealthResult {
  checks: HostInstallCheck[];
  daemonReachable: boolean;
  daemonPort: number;
  daemonVersion?: string;
}

// `timeout` on an active unit is deliberately downgraded to `warn`: the
// daemon's `/info` has been measured at 3.5-6.7s on a loaded production host
// (fork-storm profile), so a bare 2s timeout does not by itself mean the
// service is broken — it must not fail the exit code. `connection-refused` on
// an active unit means nothing is actually listening despite systemd's
// bookkeeping — definitively broken, `error`. `http-error` (the process
// answered, but with a non-2xx status) and the neutral `unknown` bucket stay
// `error` too: unlike a timeout, both mean the transport round-tripped and
// came back with something other than success, which is not explained by
// load alone.
function activeButUnreachableCheck(
  id: ServiceId,
  unit: string,
  url: string,
  reason: ProbeReason,
  restartCmd: string,
): HostInstallCheck {
  if (reason === "timeout") {
    return {
      id: `${id}-reachable`,
      ok: false,
      severity: "warn",
      detail: `${unit} is active but did not respond at ${url} within 2s (may be under load)`,
    };
  }
  return {
    id: `${id}-reachable`,
    ok: false,
    severity: "error",
    detail: `${unit} is active but unreachable at ${url} (${reason})`,
    fix: `${restartCmd} ${unit}`,
  };
}

// Before blaming a busy port on a foreign process, ask systemd whether the
// unit's own `MainPID` is the process actually holding the port — not by
// re-probing `/info` a second time (identical to, and only reached after, the
// request that already failed above; a slow-but-live Spur daemon would fail
// that second request exactly the same way as the first). `daemon` and `web`
// are both host-global fallback ports (the daemon defaults to 4310 with no
// instance config, the web unit to 5555 with no unit file), so the unit's own
// process bound there — even before systemd reports it fully "active" — must
// not be reported as a foreign port conflict.
function getUnitMainPid(ctl: string[], unit: string): number | undefined {
  const [bin, ...args] = ctl;
  if (!bin) return undefined;
  const raw = tryExec(bin, [...args, "show", unit, "-p", "MainPID", "--value"]);
  if (raw === undefined) return undefined;
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// B1: a plain `isActive(...) === false` collapses "cleanly stopped" and
// "crash-looping" into the same generic detail — enrich it with the extra
// systemd properties a crash-loop actually shows up in, so the fix a user is
// given isn't just "restart" (which would crash-loop again). Falls back to
// today's plain wording whenever the richer query fails or the unit is
// genuinely just inactive.
//
// Deliberately omits `--value` and parses `Key=Value` lines instead of
// relying on line position: a real systemd does NOT emit multi-property
// `show -p A,B,C,D --value` output in the requested property order (verified
// against a real crash-looping unit — it came back `NRestarts`,
// `ExecMainStatus`, `ActiveState`, `SubState`, not the requested order), so a
// positional `raw.split("\n")` destructure silently mis-attributes every
// field.
function describeInactiveUnit(ctl: string[], unit: string): string {
  const fallback = `${unit} not active`;
  const [bin, ...args] = ctl;
  if (!bin) return fallback;
  const raw = tryExec(bin, [
    ...args,
    "show",
    unit,
    "-p",
    "ActiveState,SubState,NRestarts,ExecMainStatus",
  ]);
  if (raw === undefined) return fallback;
  const props = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    props.set(line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim());
  }
  const activeState = props.get("ActiveState");
  const subState = props.get("SubState");
  const nRestarts = props.get("NRestarts");
  const execMainStatus = props.get("ExecMainStatus");
  if (activeState === "failed") {
    return `${unit} failed (substate: ${subState || "unknown"}, restarts: ${nRestarts || "unknown"}, last exit status: ${execMainStatus || "unknown"}) — check \`journalctl --user -u ${unit}\` before restarting`;
  }
  if (activeState === "activating") {
    return `${unit} is activating/auto-restarting (restarts: ${nRestarts || "unknown"}) — may be crash-looping; check \`journalctl --user -u ${unit}\` before restarting`;
  }
  return fallback;
}

// A1: `ExecStart=/usr/bin/node <path>.js ...` (both scopes' daemon unit, and
// the npm-scope web unit) — the same line-scanning style `resolveWebPort`
// uses for `Environment=PORT=`. `%h` is systemd's own runtime substitution
// (never rewritten in the installed unit file on disk), so it must be
// manually substituted here. Returns `undefined` when no `.js`-suffixed
// token exists (the system-scope web unit's `ExecStart=/usr/bin/pnpm
// ui:start` has no resolvable file argument at all).
function extractExecStartJsTarget(contents: string, home: string): string | undefined {
  let target: string | undefined;
  for (const line of contents.split("\n")) {
    const match = /^ExecStart=(.+)$/.exec(line.trim());
    const token = match?.[1]?.split(/\s+/).find((part) => part.endsWith(".js"));
    if (token) target = token;
  }
  return target?.replaceAll("%h", home);
}

function extractWorkingDirectory(contents: string): string | undefined {
  let workingDir: string | undefined;
  for (const line of contents.split("\n")) {
    const match = /^WorkingDirectory=(.+)$/.exec(line.trim());
    if (match?.[1]) workingDir = match[1];
  }
  return workingDir;
}

// A2: the npm-scope web unit's `WorkingDirectory` *is* the web bundle root
// (node-pty lives at `<WorkingDirectory>/node_modules/node-pty`); the
// system/source-checkout scope's `WorkingDirectory` is the repo root instead
// (node-pty is pnpm-symlinked one level down, under `packages/web`). Tries
// the npm-scope layout first, then the source-checkout layout.
function resolveWebBundleCandidates(workingDir: string): string[] {
  return [workingDir, join(workingDir, "packages", "web")];
}

// Runs `node -e "require('node-pty')"` out-of-process (never inside the real
// server) against the first bundle candidate that actually has a node-pty
// install, so a broken/ABI-mismatched native binding is caught without ever
// crashing (or depending on) the real web server. Skips (returns
// `undefined`, pushes nothing) when neither candidate has node-pty at all —
// this is not a config that ships node-pty, so there is nothing to diagnose.
function checkNodePtyLoads(webUnitContents: string, home: string): HostInstallCheck | undefined {
  const workingDir = extractWorkingDirectory(webUnitContents)?.replaceAll("%h", home);
  if (!workingDir) return undefined;
  const candidate = resolveWebBundleCandidates(workingDir).find((dir) =>
    existsSync(join(dir, "node_modules", "node-pty")),
  );
  if (!candidate) return undefined;
  try {
    execFileSync("node", ["-e", 'require("node-pty")'], {
      cwd: candidate,
      timeout: NODE_PTY_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return {
      id: "web-native-module-load",
      ok: true,
      severity: "error",
      detail: `node-pty loads in ${candidate}`,
    };
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      id: "web-native-module-load",
      ok: false,
      severity: "error",
      detail: `node-pty failed to load in ${candidate}: ${stderr}`,
      fix: "reinstall/rebuild node-pty for this host's Node ABI (spur update, or reinstall the npm package)",
    };
  }
}

function checkDirWritable(id: string, dir: string): HostInstallCheck {
  if (!existsSync(dir)) {
    return {
      id,
      ok: false,
      severity: "error",
      detail: `${dir} does not exist`,
      fix: `create ${dir}`,
    };
  }
  const probePath = join(dir, `.spur-doctor-probe-${randomUUID()}`);
  try {
    writeFileSync(probePath, "", { flag: "wx" });
    return { id, ok: true, severity: "error", detail: `${dir} is writable` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id,
      ok: false,
      severity: "error",
      detail: `${dir} is not writable (${message})`,
      fix: `fix permissions on ${dir}`,
    };
  } finally {
    try {
      unlinkSync(probePath);
    } catch {
      // Best effort only — never leave the probe file behind, but a missing
      // probe (write itself failed) is not itself a reportable condition.
    }
  }
}

function checkDiskSpace(id: string, dir: string): HostInstallCheck {
  const kbOutput = tryExec("df", ["-Pk", dir], { timeoutMs: DISK_SPACE_PROBE_TIMEOUT_MS });
  const iOutput = tryExec("df", ["-Pi", dir], { timeoutMs: DISK_SPACE_PROBE_TIMEOUT_MS });
  const availKb = parseDfField(kbOutput, 3);
  const freeInodes = parseDfField(iOutput, 3);
  if (availKb === undefined && freeInodes === undefined) {
    return {
      id,
      ok: true,
      severity: "info",
      detail: "skipped — df unavailable or non-numeric on this filesystem",
    };
  }
  if (availKb !== undefined && availKb < DISK_SPACE_MIN_FREE_KB) {
    return {
      id,
      ok: false,
      severity: "error",
      detail: `${dir} has only ${availKb}KB free (below the ${DISK_SPACE_MIN_FREE_KB}KB floor)`,
      fix: `free up disk space on the filesystem containing ${dir}`,
    };
  }
  if (freeInodes !== undefined && freeInodes === 0) {
    return {
      id,
      ok: false,
      severity: "error",
      detail: `${dir} has 0 free inodes`,
      fix: `free up inodes on the filesystem containing ${dir}`,
    };
  }
  return { id, ok: true, severity: "error", detail: `${dir} has sufficient free space and inodes` };
}

// Ungated (unlike checkDiskSpace, which needs a live unitsInstalled host):
// `home` is always readable, so this can report on a bare, un-initialized
// host too. `warn`, not `error` — a low-headroom host is a nudge toward
// `spur cache`, not a broken install, so this can never move doctor's exit
// code (hasErrorSeverity only counts severity:"error").
function checkHomeDiskHeadroom(home: string, warnFreeGb: number): HostInstallCheck {
  const id = "home-disk-headroom";
  const kbOutput = tryExec("df", ["-Pk", home], { timeoutMs: DISK_SPACE_PROBE_TIMEOUT_MS });
  const availKb = parseDfField(kbOutput, 3);
  if (availKb === undefined) {
    return {
      id,
      ok: true,
      severity: "info",
      detail: "skipped — df unavailable or non-numeric on this filesystem",
    };
  }
  const warnFreeKb = warnFreeGb * 1024 * 1024;
  const availGb = (availKb / (1024 * 1024)).toFixed(1);
  const ok = availKb >= warnFreeKb;
  return {
    id,
    ok,
    severity: "warn",
    detail: ok
      ? `${home} has ${availGb}GB free (>= ${warnFreeGb}GB floor)`
      : `${home} has only ${availGb}GB free (below the ${warnFreeGb}GB floor)`,
    ...(ok ? {} : { fix: "spur cache --prune --yes" }),
  };
}

// Bounds the whole `planCachePrune` measurement, independent of any single
// `du` chunk's own CACHE_MEASURE_TIMEOUT_MS (30s) — a host with several
// large, unresponsive roots could otherwise chain multiple per-root
// timeouts into a much longer `spur doctor` hang. Above a cold-cache full
// sweep on a heavily-used host (measured ~24s), with headroom: the budget
// also drives an AbortController that actually kills the in-flight `du`
// child on expiry (see `signal` below), so raising it doesn't risk `spur
// doctor` hanging past it — it only gives a cold run enough room to finish
// and report a real number instead of "skipped" every time.
const RECLAIMABLE_CACHES_BUDGET_MS = 45_000;
const RECLAIMABLE_CACHES_TOP_N = 5;

function renderReclaimableDetail(plan: CachePlan): string {
  const prunable = prunableCandidates(plan);
  if (prunable.length === 0) {
    return "no reclaimable caches found";
  }
  const top = prunable
    .slice(0, RECLAIMABLE_CACHES_TOP_N)
    .map(
      (candidate) =>
        `${formatCacheSizeGb(candidate.entry.sizeKb)} age ${candidate.entry.ageDays}d ${candidate.entry.path}`,
    )
    .join("; ");
  return `${formatCacheSizeGb(plan.reclaimableKb)} reclaimable across ${prunable.length} entries (top ${Math.min(RECLAIMABLE_CACHES_TOP_N, prunable.length)}: ${top}) — see \`spur cache\` for the full report`;
}

// Ungated, like `home-disk-headroom` — always `ok:true, severity:"info"`, so
// it can never move `hasErrorSeverity`/doctor's exit code. `du` writes
// nothing, so this stays compliant with doctor's read-only contract; it
// mirrors the `df`-unavailable degrade path (`checkHomeDiskHeadroom` above)
// on any measurement error/timeout instead of throwing.
async function checkReclaimableCaches(
  home: string,
  instanceConfig: InstanceConfigReadResult,
): Promise<HostInstallCheck> {
  const id = "reclaimable-caches";
  // The abort actually kills the in-flight `du` child on budget expiry
  // (planCachePrune threads `signal` down to `execFile`) so a wedged/slow
  // measurement can never keep `spur doctor`'s process alive past the
  // budget — `withTimeout` alone only abandons the await, it does not stop
  // the underlying work.
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), RECLAIMABLE_CACHES_BUDGET_MS);
  abortTimer.unref();
  try {
    const plan = await withTimeout(
      planCachePrune({ home, instanceConfig, signal: controller.signal }),
      RECLAIMABLE_CACHES_BUDGET_MS,
      "measurement budget exceeded",
    );
    return { id, ok: true, severity: "info", detail: renderReclaimableDetail(plan) };
  } catch {
    return { id, ok: true, severity: "info", detail: "skipped — measurement budget exceeded" };
  } finally {
    clearTimeout(abortTimer);
  }
}

// A healthy host registers one instance config plus one per real repo
// (single digits). 24 is ~3x headroom over any plausible fleet and far under
// the observed 92-entry pathological state (worktree spur.yaml copies
// auto-registered and never unregistered).
const CONFIG_REGISTRY_MAX_PATHS = 24;

// Pure over the file it reads: fast-tier testable without a running daemon.
// `warn` only — never changes hasErrorSeverity or the process exit code.
// Note: doctor resolves the instance config from SPUR_CONFIG/default and
// ignores --config, so this check reflects that same instance, not
// necessarily the one passed via --config.
export function checkConfigRegistry(dataDir: string, worktreeDir: string): HostInstallCheck {
  const configPaths = readConfigRegistryFile(dataDir).configPaths;
  const deadPaths: string[] = [];
  const worktreeInternalPaths: string[] = [];
  for (const path of configPaths) {
    if (!isExistingFile(path)) {
      deadPaths.push(path);
      continue;
    }
    if (isInsideWorktreeDir(path, worktreeDir)) {
      worktreeInternalPaths.push(path);
    }
  }
  const overCap = configPaths.length > CONFIG_REGISTRY_MAX_PATHS;
  const ok = deadPaths.length === 0 && worktreeInternalPaths.length === 0 && !overCap;
  if (ok) {
    return {
      id: "config-registry",
      ok: true,
      severity: "warn",
      detail: `${configPaths.length} registered config path(s), all live and outside worktreeDir`,
    };
  }
  const offending = [...deadPaths, ...worktreeInternalPaths].slice(0, 3);
  const facts: string[] = [`${configPaths.length} registered config path(s)`];
  if (deadPaths.length > 0) facts.push(`${deadPaths.length} dead`);
  if (worktreeInternalPaths.length > 0)
    facts.push(`${worktreeInternalPaths.length} worktree-internal`);
  if (overCap) facts.push(`over the ${CONFIG_REGISTRY_MAX_PATHS}-path cap`);
  const detail =
    offending.length > 0
      ? `${facts.join(", ")}: ${offending.join(", ")} (doctor reads the instance config from SPUR_CONFIG/default and ignores --config)`
      : `${facts.join(", ")} (doctor reads the instance config from SPUR_CONFIG/default and ignores --config)`;
  // `spur disconnect` only helps a dead entry — it filters `this.registryPaths`,
  // which never contains a worktree-internal path (the boot/preview prune
  // already dropped it), so pointing that fix at one is a silent no-op that
  // keeps this check red forever. Worktree-internal entries only clear on the
  // next daemon restart, which re-runs the boot prune.
  const fixParts: string[] = [];
  if (deadPaths.length > 0) {
    fixParts.push(`spur disconnect <path> for a dead entry, e.g. spur disconnect ${deadPaths[0]}`);
  }
  if (worktreeInternalPaths.length > 0) {
    fixParts.push("restart the daemon to prune worktree-internal entries at boot");
  }
  return {
    id: "config-registry",
    ok: false,
    severity: "warn",
    detail,
    ...(fixParts.length > 0 ? { fix: fixParts.join("; ") } : {}),
  };
}

// `du -sk <dir>` first line, first whitespace-delimited field (KB total).
function parseDuKb(output: string | undefined): number | undefined {
  if (!output) return undefined;
  const firstLine = output.trim().split("\n")[0];
  if (!firstLine) return undefined;
  const raw = firstLine.trim().split(/\s+/)[0];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// The global events.jsonl/user-actions.jsonl logs (and their .gz archives)
// live at the data-dir root, disjoint from <dataDir>/sessions — eventLog.*
// governs the events.jsonl family and userActionLog.* the user-actions.jsonl
// one, so the doctor total must include both. A plain readdir+stat over the
// root (never recursive) stays cheap regardless of how large `sessions` is.
function rootLogFileBytes(dataDir: string): number {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!name.startsWith("events.jsonl") && !name.startsWith("user-actions.jsonl")) {
      continue;
    }
    try {
      total += statSync(join(dataDir, name)).size;
    } catch {
      // Removed between readdir and stat — not itself a reportable condition.
    }
  }
  return total;
}

function checkLogBytes(id: string, dataDir: string): HostInstallCheck {
  const sessionsDir = join(dataDir, "sessions");
  // A fresh instance (or one that has never spawned a session) has no
  // sessions dir at all; du exits non-zero on a missing path, which would
  // otherwise read as "du unavailable" instead of the true 0KB.
  let sessionsKb: number | undefined = existsSync(sessionsDir) ? undefined : 0;
  if (sessionsKb === undefined) {
    const duOutput = tryExec("du", ["-sk", sessionsDir], {
      timeoutMs: LOG_BYTES_PROBE_TIMEOUT_MS,
    });
    sessionsKb = parseDuKb(duOutput);
  }
  if (sessionsKb === undefined) {
    return {
      id,
      ok: true,
      severity: "info",
      detail: "skipped — du unavailable or non-numeric on this filesystem",
    };
  }
  const totalKb = sessionsKb + Math.ceil(rootLogFileBytes(dataDir) / 1024);
  if (totalKb > LOG_BYTES_WARN_KB) {
    return {
      id,
      ok: false,
      severity: "warn",
      detail: `Spur logs under ${dataDir} total ${totalKb}KB (above the ${LOG_BYTES_WARN_KB}KB warn threshold)`,
      fix: `lower eventLog.shardHotBytes / eventLog.retainArchives and userActionLog.shardHotBytes / userActionLog.retainArchives in ~/.spur/config.yaml`,
    };
  }
  return {
    id,
    ok: true,
    severity: "warn",
    detail: `Spur logs under ${dataDir} total ${totalKb}KB (within the ${LOG_BYTES_WARN_KB}KB warn threshold)`,
  };
}

async function portConflictCheck(
  id: ServiceId,
  unit: string,
  port: number,
  ctl: string[],
): Promise<HostInstallCheck> {
  const ownPid = getUnitMainPid(ctl, unit);
  const pids = await findListenerPids(port);
  if (ownPid !== undefined && pids.includes(ownPid)) {
    return {
      id: `${id}-reachable`,
      ok: false,
      severity: "warn",
      detail: `${unit} is not yet reported active by systemd, but port ${port} is already held by its own process (pid ${ownPid})`,
    };
  }
  return {
    id: `${id}-port-conflict`,
    ok: false,
    severity: "error",
    detail: `port ${port} expected for ${unit} is held by another process (pid ${pids.join(", ") || "unknown"})`,
  };
}

function notRunningCheck(id: ServiceId, unit: string, port: number): HostInstallCheck {
  return {
    id: `${id}-reachable`,
    ok: false,
    severity: "warn",
    detail: `${unit} is not running (port ${port} is free)`,
  };
}

// F6: on an initialized host (systemd units installed), "not running" is
// always an error — "the daemon is dead" is the most common reason a user
// runs `doctor` at all, so it must be exit-code-affecting even for a
// deliberate `systemctl stop`. Reuses the already-computed
// `daemonActive`/`webActive` booleans instead of re-querying systemd a second
// time. Exported so fast tests can drive daemon/web active-vs-inactive
// scenarios directly, without simulating systemctl.
//
// The daemon's liveness probe hits `/info`, not `/sessions` — `/sessions`
// resolves to the heavy `view=full` enrichment path (`server.ts`), so under
// load a healthy-but-busy daemon could time out and get misreported as an
// error. `/info` doubles as the F8 version-drift source, fetched at most once
// here and threaded through `daemonVersion` so a reachable daemon costs one
// round trip, not two.
//
// `systemdReportsActivity` is true exactly when the caller already pushed a
// `spur-daemon`/`spur-web` "active"/"not active" `error`-severity check from
// systemd state — in that case the plain "not running, port free" fact here
// would just repeat the same condition at a second severity, so it is
// suppressed (single owner: the systemd-derived check). The other branches
// (active-but-unreachable, port-conflict) still surface regardless, because
// they carry information systemd alone does not have.
export async function checkServiceHealth(
  scope: SystemdScope,
  daemonActive: boolean,
  webActive: boolean,
  systemdReportsActivity: boolean,
  // E1: the daemon's real bind address (`server.host`) is not always
  // loopback (e.g. a Tailscale/LAN IP); defaulting keeps every existing
  // direct call in this file's own tests unchanged.
  daemonHost = "127.0.0.1",
): Promise<ServiceHealthResult> {
  const daemonPort = resolveDaemonPortReadOnly();
  const webPort = readWebPort(scope);
  // `server.host` is a *listen* address; a bind-all value (`0.0.0.0` / `::`)
  // is not a valid *connect* target on every platform (`http://0.0.0.0:port`
  // routes to loopback on Linux but not on macOS/Windows). Probe loopback in
  // that case so a healthy bind-all daemon is never mis-reported as
  // connection-refused. A concrete non-loopback bind (Tailscale/LAN IP) is
  // still probed as configured.
  const daemonProbeHost =
    daemonHost === "0.0.0.0" || daemonHost === "::" ? "127.0.0.1" : daemonHost;
  const daemonInfoUrl = `http://${daemonProbeHost}:${daemonPort}/info`;

  const checks: HostInstallCheck[] = [];
  let daemonReachable = false;
  let daemonVersion: string | undefined;

  const daemonInfo = await probeInfo({ id: "daemon", url: daemonInfoUrl });
  if (daemonInfo.ok) {
    daemonReachable = true;
    daemonVersion = daemonInfo.version;
    checks.push({
      id: "daemon-reachable",
      ok: true,
      severity: "info",
      detail: `spur-daemon.service responded at ${daemonInfoUrl}`,
    });
    // Read-only headroom check: daemon unreachable or the fetch/parse
    // failing pushes no check at all — the daemon-reachable check above
    // already owns that fact. Never severity "error": a full host is an
    // operator decision (raise the cap or stop sessions), not a doctor
    // failure, so hasErrorSeverity can never flip the exit code on it.
    const headroomUrl = `http://${daemonProbeHost}:${daemonPort}/headroom`;
    const headroomResult = await probeHeadroom(headroomUrl);
    if (headroomResult.ok) {
      const { live, cap, guard, sessions, projectedRoom } = headroomResult.body;
      const overCap = live.count >= cap.global || guard.crossed;
      const sessionRss = renderSessionRss(sessions);
      if (overCap) {
        const candidateIds = sessions.slice(0, 3).map((session) => session.id);
        const fix =
          candidateIds.length > 0
            ? `raise admission.maxLiveSessions in ~/.spur/config.yaml, or stop sessions: ${candidateIds.join(", ")}`
            : "free host memory or swap, or adjust admission.memoryGuard.minAvailableBytes or admission.memoryGuard.minFreeSwapBytes in ~/.spur/config.yaml";
        checks.push({
          id: "session-headroom",
          ok: false,
          severity: "warn",
          detail: `${live.count}/${cap.global} live sessions${guard.crossed ? " (memory guard crossed)" : ""}${sessionRss}`,
          fix,
        });
      } else {
        checks.push({
          id: "session-headroom",
          ok: true,
          severity: "warn",
          detail: `${live.count}/${cap.global} live sessions, room for ${projectedRoom} more${sessionRss}`,
        });
      }
    }
  } else if (daemonActive) {
    checks.push(
      activeButUnreachableCheck(
        "daemon",
        "spur-daemon.service",
        daemonInfoUrl,
        daemonInfo.reason,
        scope.restartCmd,
      ),
    );
  } else if (!(await isHostPortFree(daemonPort))) {
    checks.push(await portConflictCheck("daemon", "spur-daemon.service", daemonPort, scope.ctl));
  } else if (!systemdReportsActivity) {
    checks.push(notRunningCheck("daemon", "spur-daemon.service", daemonPort));
  }

  const webUrl = `http://127.0.0.1:${webPort}/`;
  const webResult = await probe({ id: "web", url: webUrl });
  if (webResult.ok) {
    checks.push({
      id: "web-reachable",
      ok: true,
      severity: "info",
      detail: `spur-web.service responded at ${webUrl}`,
    });
  } else if (webActive) {
    checks.push(
      activeButUnreachableCheck(
        "web",
        "spur-web.service",
        webUrl,
        webResult.reason,
        scope.restartCmd,
      ),
    );
  } else if (!(await isHostPortFree(webPort))) {
    checks.push(await portConflictCheck("web", "spur-web.service", webPort, scope.ctl));
  } else if (!systemdReportsActivity) {
    checks.push(notRunningCheck("web", "spur-web.service", webPort));
  }

  return { checks, daemonReachable, daemonPort, ...(daemonVersion ? { daemonVersion } : {}) };
}

// F8: derived from the `/info` body `checkServiceHealth` already fetched for
// liveness — never issues a second request, and stays silent when the daemon
// was unreachable (no version to compare).
export function checkVersionDrift(daemonVersion: string | undefined): HostInstallCheck | undefined {
  if (!daemonVersion) return undefined;
  const installedVersion = getVersion();
  const drifted = daemonVersion !== installedVersion;
  // Static severity (see `checkSpurOnPath`): always "warn" — drift is never
  // exit-code-affecting, whether or not it is currently present.
  // `spur update` only works against a real npm release (see
  // `assertNotSourceCheckout` in update.ts); a `git describe`-shaped version
  // means this is a source checkout, where that fix is a dead end -- point
  // at the repo deploy flow instead.
  const fix = isReleaseVersion(installedVersion) ? "spur update" : "pull latest and redeploy";
  return {
    id: "version-drift",
    ok: !drifted,
    severity: "warn",
    detail: drifted
      ? `daemon reports version ${daemonVersion}, installed package is ${installedVersion}`
      : `daemon version ${daemonVersion} matches the installed package`,
    ...(drifted ? { fix } : {}),
  };
}

export async function collectHostInstallChecks(home = homedir()): Promise<HostInstallCheck[]> {
  const checks: HostInstallCheck[] = [];
  const scope = resolveSystemdScope(home);
  const expectedPrefix = npmGlobalPrefix(home);

  // Same `$HOME`-at-spawn-time divergence as `ensureNpmPinFile`/
  // `healNpmrcPrefixLine`: an inherited `npm_config_userconfig` outranks
  // `HOME` as npm's userconfig
  // source, so without `--userconfig` the probe could read a different file
  // than the `<home>/.npmrc` `expectedPrefix` above is derived from.
  // `--globalconfig` points the probe at the persisted pin: Spur writes it to
  // its own `<home>/.spur/npmrc`, not `<home>/.npmrc` (nvm greps the latter
  // for a `prefix=`/`globalconfig=` line and refuses to load when it finds
  // one).
  //
  // Spur pins the globalconfig keys (both casings) into every agent session's
  // env (see `session-service.ts`), so a `spur doctor` run from inside a
  // session would otherwise read back its own env pin instead of the
  // persisted state this check exists to detect drift in. Strip every
  // sanitized key so the probe reports the files, not the session.
  const sanitizeKeys: ReadonlySet<string> = new Set(NPM_PIN_SANITIZE_ENV_KEYS);
  const restEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !sanitizeKeys.has(key)),
  );
  const npmPrefix = tryExec(
    "npm",
    [
      "config",
      "get",
      "prefix",
      "--userconfig",
      join(home, ".npmrc"),
      "--globalconfig",
      npmPinConfigPath(home),
    ],
    { env: { ...restEnv, HOME: home } },
  );
  checks.push({
    id: "npm-prefix",
    ok: npmPrefix === expectedPrefix,
    severity: "warn",
    detail: npmPrefix ? `npm prefix is ${npmPrefix}` : "npm prefix unavailable",
    // `spur init` re-derives this exact pin via `ensureNpmPinFile` and is the
    // preferred fix; the manual fallback must chmod its own target —
    // `npm config set --location=global` chmods the file it writes to 0666
    // regardless of umask (verified empirically), which is world-writable
    // and lets any local user redirect where agent sessions install global
    // packages.
    fix: "spur init (or: npm config set prefix ~/.local --location=global --globalconfig ~/.spur/npmrc && chmod 600 ~/.spur/npmrc)",
  });

  // Read-only diagnostic (doctor never mutates): a `prefix=`/`globalconfig=`
  // line in `<home>/.npmrc` — Spur's own or an operator's — trips nvm's
  // `nvm_npmrc_bad_news_bears` guard for every shell that sources nvm's
  // `nvm.sh`, independent of the env pin above. Gated on nvm actually being
  // installed (shared `hasNvm` predicate with `healNpmrcPrefixLine`, so the
  // two conditions can never diverge): the line is harmless on any host that
  // never sources `nvm.sh`, so this stays silent there instead of warning
  // about a conflict that can't occur. Fires on an operator-set value too
  // (nvm breaks either way); the `fix` is a manual edit rather than `spur
  // reinit` (deliberately — `runNpmInit`'s `~/.npmrc` surgery only runs
  // there, and `spur reinit` itself is unsupported on system-unit hosts, see
  // install-from-npm.md).
  if (hasNvm(home)) {
    let npmrcContents: string | undefined;
    try {
      npmrcContents = readFileSync(join(home, ".npmrc"), "utf8");
    } catch {
      // Absent .npmrc: npmrcContents stays undefined, no conflict possible.
    }
    const npmrcHasNvmIncompatibleLine =
      npmrcContents !== undefined && /^\s*(prefix|globalconfig)\s*=/m.test(npmrcContents);
    checks.push({
      id: "npmrc-nvm-conflict",
      ok: !npmrcHasNvmIncompatibleLine,
      severity: "warn",
      detail: npmrcHasNvmIncompatibleLine
        ? `${join(home, ".npmrc")} has a prefix=/globalconfig= line — nvm refuses to load in any shell that sources it`
        : `${join(home, ".npmrc")} has no prefix=/globalconfig= line`,
      ...(npmrcHasNvmIncompatibleLine
        ? {
            fix: `remove the prefix=/globalconfig= line from ${join(home, ".npmrc")} by hand (nvm refuses to load while one is present); a line reading "prefix=${expectedPrefix}" is Spur's own stray pin — the persisted pin now lives in ${npmPinConfigPath(home)} instead`,
          }
        : {}),
    });
  }

  // F1/C1/C2/E1/E2 share this single read-only, non-bootstrapping instance-
  // config read (never triggers `ensureInstanceConfig`'s bootstrap write). A
  // corrupt file is surfaced here, once, as its own fact — C1/C2/E2 below are
  // skipped rather than cascading a second, derived error off of it.
  const instanceConfig = loadInstanceConfigReadOnly();
  if (instanceConfig.status === "invalid") {
    checks.push({
      id: "instance-config-corrupt",
      ok: false,
      severity: "error",
      detail: instanceConfig.error,
      fix: "fix or remove ~/.spur/config.yaml",
    });
  }

  let daemonActive = false;
  let webActive = false;
  let systemdReportsActivity = false;
  let unitsInstalled = false;

  if (scope.kind === "missing" && platform() !== "linux") {
    checks.push({
      id: "systemd-not-applicable",
      ok: true,
      severity: "info",
      detail: "systemd user units are Linux-only; verify install manually on this platform",
    });
  } else {
    const daemonUnit = join(scope.unitDir, "spur-daemon.service");
    const webUnit = join(scope.unitDir, "spur-web.service");
    unitsInstalled = scope.kind !== "missing" && existsSync(daemonUnit) && existsSync(webUnit);
    checks.push({
      id: "systemd-units",
      ok: unitsInstalled,
      severity: "warn",
      detail: unitsInstalled
        ? scope.kind === "system"
          ? "system systemd units installed"
          : "user systemd units installed"
        : "spur-daemon.service or spur-web.service missing",
      ...(scope.kind === "system" ? {} : { fix: "spur init" }),
    });

    // A1/A2: dist/native-module integrity, read straight from the already-
    // installed unit files — only meaningful once those files actually exist.
    if (unitsInstalled) {
      const daemonUnitContents = readFileSync(daemonUnit, "utf8");
      const webUnitContents = readFileSync(webUnit, "utf8");

      const daemonTarget = extractExecStartJsTarget(daemonUnitContents, home);
      if (daemonTarget) {
        const targetExists = existsSync(daemonTarget);
        checks.push({
          id: "daemon-dist-integrity",
          ok: targetExists,
          severity: "error",
          detail: targetExists ? `${daemonTarget} exists` : `${daemonTarget} is missing`,
          ...(targetExists
            ? {}
            : { fix: "reinstall spur (npm install -g @shugaev/spur, or spur update)" }),
        });
      }

      const webTarget = extractExecStartJsTarget(webUnitContents, home);
      if (webTarget) {
        const targetExists = existsSync(webTarget);
        checks.push({
          id: "web-dist-integrity",
          ok: targetExists,
          severity: "error",
          detail: targetExists ? `${webTarget} exists` : `${webTarget} is missing`,
          ...(targetExists
            ? {}
            : { fix: "reinstall spur (npm install -g @shugaev/spur, or spur update)" }),
        });
      }

      const nodePtyCheck = checkNodePtyLoads(webUnitContents, home);
      if (nodePtyCheck) checks.push(nodePtyCheck);
    }

    if (scope.kind === "system") {
      checks.push({
        id: "linger",
        ok: true,
        severity: "warn",
        detail: "system units (linger not required)",
      });
    } else {
      const user = process.env["LOGNAME"] || process.env["USER"] || "";
      const linger = user ? tryExec("loginctl", ["show-user", user, "-p", "Linger"]) : undefined;
      const lingerOk = linger === "Linger=yes";
      checks.push({
        id: "linger",
        ok: lingerOk,
        severity: "warn",
        detail: lingerOk ? "linger enabled" : "linger disabled or loginctl unavailable",
        fix: "loginctl enable-linger $USER",
      });
    }

    const [ctlBin, ...ctlArgs] = scope.ctl;
    const systemdAvailable =
      ctlBin !== undefined && tryExec(ctlBin, ctlArgs.concat("status")) !== undefined;
    systemdReportsActivity = unitsInstalled && systemdAvailable;
    if (systemdReportsActivity) {
      // Once units are installed, "not active" is a genuine failure — error =
      // something is BROKEN (a fresh, never-`init`'d host is a different
      // case: `systemd-units` above stays `warn` and this block never runs).
      // "The daemon is dead" is the single most common reason a user runs
      // `doctor`, so it must be exit-code-affecting on an initialized host,
      // including a deliberate `systemctl stop`. `checkServiceHealth` below
      // suppresses its own plain "not running" check when this block already
      // owns the fact, so it is reported at exactly one severity, not two.
      daemonActive = isActive(scope.ctl, "spur-daemon.service");
      checks.push({
        id: "spur-daemon",
        ok: daemonActive,
        severity: "error",
        detail: daemonActive
          ? "spur-daemon.service active"
          : describeInactiveUnit(scope.ctl, "spur-daemon.service"),
        fix: `${scope.restartCmd} spur-daemon.service`,
      });

      webActive = isActive(scope.ctl, "spur-web.service");
      checks.push({
        id: "spur-web",
        ok: webActive,
        severity: "error",
        detail: webActive
          ? "spur-web.service active"
          : describeInactiveUnit(scope.ctl, "spur-web.service"),
        fix: `${scope.restartCmd} spur-web.service`,
      });
    }
  }

  checks.push(checkSpurOnPath(npmPrefix));
  checks.push(checkTmuxInstalled());
  checks.push(checkGitInstalled());
  checks.push(checkNodeVersion());

  const warnFreeGb =
    instanceConfig.status === "ok"
      ? instanceConfig.config.diskRetention.warnFreeGb
      : DEFAULT_DISK_RETENTION.warnFreeGb;
  checks.push(checkHomeDiskHeadroom(home, warnFreeGb));
  checks.push(await checkReclaimableCaches(home, instanceConfig));

  // C1/C2/E2 additionally require `unitsInstalled` (not just a readable
  // instance config) — an instance config can legitimately exist (e.g. a
  // pinned `SPUR_CONFIG`) before the daemon has ever created `dataDir`/
  // `worktreeDir` or before the web unit is installed; only a genuinely
  // initialized host (systemd units present) makes a missing/unwritable dir
  // or a port mismatch an actual fact worth reporting.
  if (instanceConfig.status === "ok" && unitsInstalled) {
    checks.push(checkDirWritable("worktree-dir-writable", instanceConfig.config.worktreeDir));
    checks.push(checkDirWritable("data-dir-writable", instanceConfig.config.dataDir));
    checks.push(checkDiskSpace("data-dir-disk-space", instanceConfig.config.dataDir));
    checks.push(
      checkConfigRegistry(instanceConfig.config.dataDir, instanceConfig.config.worktreeDir),
    );
    checks.push(checkLogBytes("data-dir-log-bytes", instanceConfig.config.dataDir));

    const actualWebPort = readWebPort(scope);
    const configuredWebPort = instanceConfig.config.ui.port;
    const portsDrifted = actualWebPort !== configuredWebPort;
    checks.push({
      id: "web-ui-port-drift",
      ok: !portsDrifted,
      severity: "warn",
      detail: portsDrifted
        ? `configured ui.port ${configuredWebPort} does not match the web unit's actual listen port ${actualWebPort}`
        : `ui.port ${configuredWebPort} matches the web unit's actual listen port ${actualWebPort}`,
      ...(portsDrifted
        ? {
            fix: `align ui.port in ~/.spur/config.yaml with the web unit's real PORT (${actualWebPort}), or reinit with --web-port ${configuredWebPort}`,
          }
        : {}),
    });

    checks.push(await checkLeakedSidecars(instanceConfig.config));
  }

  const daemonHost =
    instanceConfig.status === "ok" ? instanceConfig.config.server.host : "127.0.0.1";
  const health = await checkServiceHealth(
    scope,
    daemonActive,
    webActive,
    systemdReportsActivity,
    daemonHost,
  );
  checks.push(...health.checks);
  const drift = checkVersionDrift(health.daemonVersion);
  if (drift) checks.push(drift);

  return checks;
}

function formatSweepTreeLine(tree: {
  rootPid: number;
  pgid: number;
  treeRssKb: number;
  ageSeconds: number;
  worktreePath: string;
  sidecarName: string | null;
}): string {
  const ageMinutes = Math.floor(tree.ageSeconds / 60);
  const hours = Math.floor(ageMinutes / 60);
  const minutes = ageMinutes % 60;
  // Tree total, not the root pid's own rss — the root alone understated the
  // measured 863333/863351 leak by 17x.
  const rssMb = Math.round(tree.treeRssKb / 1024);
  return `  pid ${tree.rootPid}  pgid ${tree.pgid}  rss ${rssMb} MB  age ${hours}h${minutes}m  ${tree.worktreePath}  ${tree.sidecarName ?? "unattributed"}`;
}

// Read-only doctor check: calls findLeakedSidecarTrees only, never
// sweepSidecars(reap: true) — doctor performs zero writes and zero signals.
async function checkLeakedSidecars(config: AppConfig): Promise<HostInstallCheck> {
  const sessions = listSessions(config.dataDir);
  const assembled = assembleSidecarSweepClaims(sessions, config.worktreeDir);
  if (!assembled) {
    return {
      id: "sidecar-orphans",
      ok: true,
      severity: "warn",
      detail: "sidecar-orphans: worktree dir unreadable, sweep skipped",
    };
  }
  const snapshot = await snapshotProcesses();
  const { supported, leaked } = await findLeakedSidecarTrees({
    snapshot,
    claims: assembled.claims,
    worktreePaths: assembled.worktreePaths,
    worktreeDirRealpath: assembled.worktreeDirRealpath,
  });
  if (!supported) {
    return {
      id: "sidecar-orphans",
      ok: true,
      severity: "warn",
      detail: "sidecar-orphans: process table unreadable, sweep skipped",
    };
  }
  if (leaked.length === 0) {
    return {
      id: "sidecar-orphans",
      ok: true,
      severity: "warn",
      detail: "sidecar-orphans: none found",
    };
  }
  const shown = leaked.slice(0, SWEEP_DETAIL_MAX_TREES);
  const remaining = leaked.length - shown.length;
  const detail = [
    `sidecar-orphans: ${leaked.length} leaked sidecar process tree(s) found`,
    ...shown.map(formatSweepTreeLine),
    ...(remaining > 0 ? [`  +${remaining} more`] : []),
  ].join("\n");
  return {
    id: "sidecar-orphans",
    ok: false,
    severity: "warn",
    detail,
    fix: "spur sidecar sweep --reap",
  };
}

export function hasErrorSeverity(checks: HostInstallCheck[]): boolean {
  return checks.some((check) => !check.ok && check.severity === "error");
}

export function renderHostInstallChecks(checks: HostInstallCheck[]): string {
  // Severity is a static per-check importance, not a pass/fail flag (see
  // `checkSpurOnPath`) — only surface it once a check has actually failed, so
  // a passing check is never rendered as `[error]`.
  const lines = checks.map((check) => {
    const mark = check.ok ? "ok" : check.severity;
    const fixSeparator = check.detail.includes("\n") ? "\n  " : " — ";
    const fix = check.ok || !check.fix ? "" : `${fixSeparator}fix: ${check.fix}`;
    return dimText(`[${mark}] ${check.detail}${fix}`);
  });
  return lines.join("\n");
}

export function resolveNpmInitScript(cliEntrypoint: string): string {
  const cliPath = realpathSync(cliEntrypoint);
  return join(dirname(cliPath), "..", "scripts", "npm-init.sh");
}

export function runNpmInit(
  cliEntrypoint: string,
  options: { noStart?: boolean; exposeWeb?: boolean; webPort?: string; tailscale?: boolean },
): void {
  const script = resolveNpmInitScript(cliEntrypoint);
  if (!existsSync(script)) {
    throw new Error(`npm init script not found: ${script}`);
  }
  // Full repair: `runNpmInit` (`spur init`/`update`/`reinit`) is the one
  // caller allowed to do both the pin-file write and the `~/.npmrc` surgery
  // in one shot. Every other consumer (daemon boot) calls `ensureNpmPinFile`
  // alone — see its doc comment for why the heal half is boot-unsafe.
  ensureNpmPinFile();
  healNpmrcPrefixLine();
  const args: string[] = [];
  if (options.noStart) {
    args.push("--no-start");
  }
  if (options.exposeWeb) {
    args.push("--expose-web");
  }
  if (options.webPort) {
    args.push("--web-port", options.webPort);
  }
  args.push(options.tailscale === false ? "--no-tailscale" : "--tailscale");
  execFileSync("bash", [script, ...args], { stdio: "inherit" });
}

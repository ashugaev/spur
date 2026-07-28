import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { agentSendMode } from "./agents/index.js";
import { cursorShowsReadyPrompt, cursorShowsWorkspaceTrustPrompt } from "./cursor-state.js";
import { shellEscape } from "./agents/shell-escape.js";
import type { AgentName } from "./types.js";

// ── Session survival across daemon restarts ──
// The systemd unit uses KillMode=process, so a daemon restart only stops the
// daemon's node process — this is the actual guarantee that tmux and agents
// survive a restart. `SPUR_TMUX_SYSTEMD_SCOPE=auto` additionally launches new
// tmux sessions through `systemd-run --user --scope` as a best-effort escape
// from spur-daemon.service's cgroup, but that only engages when a per-user
// systemd manager is reachable for the service user (loginctl enable-linger +
// XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS). Without linger provisioned,
// `systemd-run --user` fails and `auto` mode falls back to direct tmux inside
// the daemon cgroup, relying solely on KillMode=process.
// After restart, the daemon re-discovers living sessions through
// applyConfig() → resumeSessionDelivery().
// See deploy/spur-daemon.service for the unit template.

const execFileAsync = promisify(execFile);
const TMUX_CONFIG_PATH = fileURLToPath(new URL("../tmux.conf", import.meta.url));
let activeTmuxSocketName: string | null = null;

// ── Shared short-TTL runtime-probe cache ──
// With ~183 sessions, the dashboard-cache tick (every 2s in session-service.ts,
// DASHBOARD_CACHE_INTERVAL_MS) and the attention monitor (every 5s) each fork
// up to 5 tmux/ps subprocesses per session through readRuntimeSnapshot. That
// serializes hundreds of forks per tick through one tmux server on the HTTP
// process and starves it. These module-level caches make the fleet-wide
// existence check, the process table, and the cheap per-session display
// probes cost O(1) forks per TTL window instead of O(sessions) — any caller
// (background tick or on-demand HTTP enrich) within the same ~2s window reuses
// the same result. The TTL matches DASHBOARD_CACHE_INTERVAL_MS so state never
// goes stale beyond what the dashboard cache already tolerates.
const RUNTIME_PROBE_CACHE_TTL_MS = 2_000;

interface ProbeCacheEntry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

// Dedups concurrent callers within the same TTL window onto one in-flight
// fetch. A dashboard-cache tick fires every session's probe via
// `Promise.all` near-simultaneously, so caching only the *resolved* value
// would still let every one of ~183 concurrent callers race past an empty
// cache and each fork their own subprocess before the first one resolves.
// Caching the promise itself (set before the first `await`) closes that gap.
//
// Per-key caches (e.g. capturePaneCache, keyed by session×lines) would
// otherwise grow unbounded on a long-running daemon — every distinct key
// ever probed stays resident forever. Sweep expired entries on every access
// so each cache self-bounds to only the keys actually live within the TTL.
// The single-key fleet caches (one entry each) pay a trivial sweep cost.
//
// A rejected fetch is evicted immediately rather than cached for the rest of
// the TTL: a transient tmux/ps failure must not be replayed as "still
// failing" to every caller in the window (e.g. a rate-limit pane scan would
// silently miss a banner for up to 2s). Callers whose fetch always resolves
// (the fleet snapshots swallow their own errors into safe empty defaults)
// are unaffected; only a fetch that actually throws hits this path.
function memoizedProbe<T>(
  cache: Map<string, ProbeCacheEntry<T>>,
  key: string,
  fetch: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  for (const [staleKey, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(staleKey);
    }
  }
  const cached = cache.get(key);
  if (cached) {
    return cached.promise;
  }
  const promise = fetch().catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { promise, expiresAt: now + RUNTIME_PROBE_CACHE_TTL_MS });
  return promise;
}

interface FleetSessionSnapshot {
  names: Set<string>;
  activity: Map<string, Date | null>;
}

const fleetSessionCache = new Map<string, ProbeCacheEntry<FleetSessionSnapshot>>();
const FLEET_SESSION_CACHE_KEY = "sessions";

// Fleet-wide session existence AND activity in ONE fork instead of one
// `has-session` plus one `display-message` per session.
// `tmuxSessionExists`/`getTmuxSessionActivity` reroute through this cached
// snapshot so the dashboard-cache tick, the attention monitor, and on-demand
// HTTP enrich all share the same ~2s fleet-wide read.
//
// Activity is `#{window_activity}` (max across the session's windows), never
// `#{session_activity}`. Measured on tmux 3.4: session_activity is a pure
// client-attach clock — it jumps to now the moment anything runs
// `attach-session` (the web terminal, `spur attach`, a user's own tmux) and
// never moves for pane output, even with a client attached, so a busy detached
// agent reported its creation time forever. window_activity is the pane-output
// clock and every read-only probe here (list-windows, list-panes -a,
// capture-pane, display-message) leaves it alone.
//
// window_activity is NOT attach-proof on its own, though: attaching resizes the
// window, and a real agent TUI repaints on SIGWINCH, which is genuine output.
// So this is the FALLBACK activity source only. Callers must prefer the agent's
// own structured artifact (session-service.ts resolveAgentActivityAt), which is
// the only signal that is identical whether or not a browser is attached.
//
// `list-windows -a` also enumerates every live session (a tmux session always
// has at least one window), so it replaces list-sessions for existence too.
function getFleetSessionSnapshot(): Promise<FleetSessionSnapshot> {
  return memoizedProbe(fleetSessionCache, FLEET_SESSION_CACHE_KEY, async () => {
    const names = new Set<string>();
    const activity = new Map<string, Date | null>();
    try {
      const out = await tmux("list-windows", "-a", "-F", "#{session_name} #{window_activity}");
      for (const line of out.trim().split("\n")) {
        const [sessionName, activitySeconds] = line.trim().split(/\s+/);
        if (!sessionName) {
          continue;
        }
        names.add(sessionName);
        const seconds = Number.parseInt(activitySeconds ?? "", 10);
        const windowActivityAt = Number.isNaN(seconds) ? null : new Date(seconds * 1000);
        const previous = activity.get(sessionName) ?? null;
        activity.set(
          sessionName,
          windowActivityAt && (!previous || windowActivityAt.getTime() > previous.getTime())
            ? windowActivityAt
            : previous,
        );
      }
    } catch {
      // No tmux server running (or another list-windows failure) — an empty
      // fleet, never a thrown error.
    }
    return { names, activity };
  });
}

export async function listTmuxSessionNames(): Promise<Set<string>> {
  return (await getFleetSessionSnapshot()).names;
}

// `fresh` busts the shared fleet-existence cache before reading, forcing one
// independent fork instead of reusing whatever the last ~2s tick saw. Only
// for rare imperative callers that need a genuine re-sample (e.g. a retry
// after a delay meant to rule out a transient glitch) — the periodic fleet
// scans never pass it.
export async function tmuxSessionExists(
  sessionName: string,
  options?: { fresh?: boolean },
): Promise<boolean> {
  if (options?.fresh) {
    fleetSessionCache.delete(FLEET_SESSION_CACHE_KEY);
  }
  return (await listTmuxSessionNames()).has(sessionName);
}

export async function getTmuxSessionActivity(sessionName: string): Promise<Date | null> {
  const { activity } = await getFleetSessionSnapshot();
  return activity.get(sessionName) ?? null;
}

interface FleetPaneEntry {
  // The session's currently displayed pane (active window's active pane) —
  // what `=name:` with no window/pane index resolves to, i.e. what
  // tmuxPaneDead/getTmuxPanePid targeted per-session before batching.
  activePaneDead: boolean;
  activePanePid: number | null;
  // Every pane's tty across the whole session (what `=name` with no window
  // targeted before batching) — isProcessRunningInTmux needs all of them
  // since the agent process can be in any pane/window of the session.
  allTtys: string[];
}

const fleetPaneCache = new Map<string, ProbeCacheEntry<Map<string, FleetPaneEntry>>>();
const FLEET_PANE_CACHE_KEY = "panes";

// Fleet-wide pane state in ONE fork (`list-panes -a`) instead of one
// `list-panes`/`display-message #{pane_dead}` per session. tmuxPaneDead,
// getTmuxPanePid, and isProcessRunningInTmux's tty lookup all reroute through
// this cached snapshot.
function getFleetPaneSnapshot(): Promise<Map<string, FleetPaneEntry>> {
  return memoizedProbe(fleetPaneCache, FLEET_PANE_CACHE_KEY, async () => {
    const panes = new Map<string, FleetPaneEntry>();
    try {
      const out = await tmux(
        "list-panes",
        "-a",
        "-F",
        "#{session_name} #{window_active} #{pane_active} #{pane_dead} #{pane_pid} #{pane_tty}",
      );
      for (const line of out.trim().split("\n")) {
        const [sessionName, windowActive, paneActive, paneDead, panePid, paneTty] = line
          .trim()
          .split(/\s+/);
        if (!sessionName) {
          continue;
        }
        const entry = panes.get(sessionName) ?? {
          activePaneDead: true,
          activePanePid: null,
          allTtys: [],
        };
        if (paneTty) {
          entry.allTtys.push(paneTty);
        }
        // window_active + pane_active together identify the exact pane a
        // no-window/no-pane target (`=name:`) resolves to.
        if (windowActive === "1" && paneActive === "1") {
          const pid = Number.parseInt(panePid ?? "", 10);
          entry.activePaneDead = paneDead === "1";
          entry.activePanePid = Number.isFinite(pid) && pid > 0 ? pid : null;
        }
        panes.set(sessionName, entry);
      }
    } catch {
      // No tmux server running (or another list-panes failure) — an empty
      // fleet, never a thrown error.
    }
    return panes;
  });
}

// `fresh` busts the shared fleet-pane cache before reading — same rationale
// as tmuxSessionExists's/isProcessRunningInTmux's `fresh`.
export async function tmuxPaneDead(
  sessionName: string,
  options?: { fresh?: boolean },
): Promise<boolean> {
  if (options?.fresh) {
    fleetPaneCache.delete(FLEET_PANE_CACHE_KEY);
  }
  const panes = await getFleetPaneSnapshot();
  return panes.get(sessionName)?.activePaneDead ?? true;
}

const CURSOR_TRUST_CONFIRM_DELAY_MS = 1_000;
const CURSOR_TRUST_CONFIRM_MAX_ATTEMPTS = 3;
const CURSOR_READY_SETTLE_DELAY_MS = 1_000;
const CODEX_READY_SETTLE_DELAY_MS = 500;
// Warn at most once per process lifetime when `auto` mode silently falls back
// to direct tmux, so the log isn't spammed once per session launch.
let warnedSystemdScopeFallback = false;
type SystemdScopeMode = "direct" | "auto" | "required";

function systemdScopeMode(): SystemdScopeMode {
  const value = process.env["SPUR_TMUX_SYSTEMD_SCOPE"]?.trim().toLowerCase();
  if (value === "1") {
    return "required";
  }
  if (value === "auto") {
    return "auto";
  }
  return "direct";
}

export function setTmuxSocketName(socketName: string | undefined): void {
  activeTmuxSocketName = socketName?.trim() || null;
}

export function getTmuxSocketName(): string | null {
  return activeTmuxSocketName;
}

export function withTmuxSocketArgs(args: string[]): string[] {
  return activeTmuxSocketName ? ["-L", activeTmuxSocketName, ...args] : args;
}

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", withTmuxSocketArgs(args));
  return stdout.trimEnd();
}

function isSystemdRunUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  if (code === "ENOENT") {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const detail = `${message}\n${stderr}`.toLowerCase();
  return (
    detail.includes("failed to connect to bus") ||
    detail.includes("system has not been booted with systemd")
  );
}

// Best-effort out-of-cgroup escape for new tmux sessions. `direct` mode always
// launches tmux inline (inside the daemon cgroup). `auto`/`required` mode
// first tries `systemd-run --user --scope` so the session lives outside
// spur-daemon.service's cgroup; `auto` falls back to direct tmux (with a
// one-time stderr warning) when no per-user systemd manager is available for
// the service user, while `required` propagates the failure. Either way,
// KillMode=process on the daemon unit remains the actual guarantee that a
// daemon restart does not stop the session.
async function runTmuxNewSession(args: string[]): Promise<void> {
  const mode = systemdScopeMode();
  if (mode === "direct") {
    await execFileAsync("tmux", args);
    return;
  }
  try {
    await execFileAsync("systemd-run", [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "tmux",
      ...args,
    ]);
  } catch (error) {
    if (mode === "auto" && isSystemdRunUnavailable(error)) {
      if (!warnedSystemdScopeFallback) {
        warnedSystemdScopeFallback = true;
        process.stderr.write(
          "spur: systemd-run --user is unavailable (no per-user systemd manager for the " +
            "service user — needs `loginctl enable-linger` plus XDG_RUNTIME_DIR/" +
            "DBUS_SESSION_BUS_ADDRESS); falling back to direct tmux inside the daemon " +
            "cgroup. Session survival across daemon restarts now relies solely on " +
            "KillMode=process.\n",
        );
      }
      await execFileAsync("tmux", args);
      return;
    }
    throw error;
  }
}

function buildEnvArgs(env?: Record<string, string>): string[] {
  const envArgs: string[] = [];
  const sessionEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
      ),
    ),
    ...(env ?? {}),
  };
  for (const [key, value] of Object.entries(sessionEnv)) {
    envArgs.push("-e", `${key}=${value}`);
  }
  return envArgs;
}

function exactSessionTarget(sessionName: string): string {
  return `=${sessionName}`;
}

function exactPaneTarget(sessionName: string): string {
  return `=${sessionName}:`;
}

// TTL-cached, in-flight-promise-memoized like the other fleet/per-session
// probes: capture-pane can't be batched fleet-wide (there's no `-a` form that
// returns per-session pane *text*), so it's the last per-session fork left in
// the classify/enrich path. Within a TTL window, the 2s dashboard tick, the
// 5s attention monitor, the viewed page's own enrich poll, and desk-sibling
// lookups all share one capture per (session, lines) pair instead of forking
// one each. Keyed by lines too since callers request different tail lengths
// (classify's default 200, attention's 15-line notice tail, sidecar's 40).
const capturePaneCache = new Map<string, ProbeCacheEntry<string>>();

// `fresh` evicts this (session, lines) cache entry before reading, forcing
// one independent fork. Needed by imperative pollers (waitForTmuxReady) that
// expect every iteration to see genuinely current pane text, not whatever
// the last ~2s tick captured.
export function captureTmuxPane(
  sessionName: string,
  lines = 200,
  options?: { fresh?: boolean },
): Promise<string> {
  const key = `${sessionName}:${lines}`;
  if (options?.fresh) {
    capturePaneCache.delete(key);
  }
  // The fetch throws on a real capture failure (rather than swallowing it
  // into "") so memoizedProbe's evict-on-reject never caches a transient
  // failure as a stable empty result for the rest of the TTL window.
  return memoizedProbe(capturePaneCache, key, () => {
    const target = exactPaneTarget(sessionName);
    return tmux("capture-pane", "-t", target, "-p", "-J", "-S", `-${lines}`);
  }).catch(() => "");
}

// Test-only introspection: capturePaneCache is keyed per (session, lines), so
// it's the one probe cache that can accumulate a distinct entry per session
// ever captured on a long-running daemon. Exposes its size so a test can
// assert memoizedProbe's expired-entry sweep keeps it bounded rather than
// growing forever.
export function _capturePaneCacheSizeForTests(): number {
  return capturePaneCache.size;
}

// Pid of the session's pane process (the shell hosting the agent). Used to
// bind ambiguous agent status files to the process actually in this pane.
export async function getTmuxPanePid(sessionName: string): Promise<number | null> {
  const panes = await getFleetPaneSnapshot();
  return panes.get(sessionName)?.activePanePid ?? null;
}

interface PsRow {
  tty: string;
  args: string;
}

// Shared, TTL-cached `ps` snapshot: the full process table is identical for
// every session in a tick, so this is one fork per TTL window instead of one
// per session.
const psSnapshotCache = new Map<string, ProbeCacheEntry<PsRow[]>>();
const PS_SNAPSHOT_CACHE_KEY = "ps";

function getPsSnapshot(): Promise<PsRow[]> {
  return memoizedProbe(psSnapshotCache, PS_SNAPSHOT_CACHE_KEY, async () => {
    try {
      const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
        timeout: 5_000,
      });
      return psOut
        .split("\n")
        .map((line) => {
          const cols = line.trimStart().split(/\s+/);
          if (cols.length < 3) {
            return null;
          }
          return { tty: cols[1] ?? "", args: cols.slice(2).join(" ") };
        })
        .filter((row): row is PsRow => row !== null);
    } catch {
      return [];
    }
  });
}

// `fresh` busts the shared fleet-pane and ps-snapshot caches before reading —
// same rationale as tmuxSessionExists's `fresh`: a session created after the
// last fleet-pane snapshot is invisible to it until the cache naturally
// expires, which would wrongly fail a post-create recovery/restore check.
export async function isProcessRunningInTmux(
  sessionName: string,
  processMatchers: string[],
  options?: { fresh?: boolean },
): Promise<boolean> {
  if (options?.fresh) {
    fleetPaneCache.delete(FLEET_PANE_CACHE_KEY);
    psSnapshotCache.delete(PS_SNAPSHOT_CACHE_KEY);
  }
  try {
    const panes = await getFleetPaneSnapshot();
    const ttys = panes.get(sessionName)?.allTtys ?? [];
    if (ttys.length === 0) {
      return false;
    }
    const ttySet = new Set(ttys.map((tty) => tty.replace(/^\/dev\//, "")));
    const processRes = processMatchers
      .filter((matcher) => matcher.trim().length > 0)
      .map(
        (matcher) =>
          new RegExp(`(?:^|/)${matcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`),
      );
    if (processRes.length === 0) {
      return false;
    }
    const rows = await getPsSnapshot();
    for (const row of rows) {
      if (!ttySet.has(row.tty)) {
        continue;
      }
      if (processRes.some((processRe) => processRe.test(row.args))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Fleet snapshots (existence+activity, panes, ps) are TTL-cached for periodic
// scans, but a tmux create/kill is a real mutation the next read must see
// immediately — otherwise a just-created session/sidecar reads as absent, or
// a just-killed/paused one reads as still alive, for up to the ~2s TTL.
// Create/kill are rare (not per-tick), so busting these three single-key
// caches here doesn't touch the per-tick fork savings the fleet batching
// exists for.
function invalidateFleetProbeCaches(): void {
  fleetSessionCache.clear();
  fleetPaneCache.clear();
  psSnapshotCache.clear();
}

export async function createTmuxSession(input: {
  sessionName: string;
  cwd: string;
  launchCommand: string;
  agent?: AgentName;
  env?: Record<string, string>;
}): Promise<void> {
  const sessionTarget = exactSessionTarget(input.sessionName);
  const envArgs = buildEnvArgs(input.env);

  await runTmuxNewSession([
    ...withTmuxSocketArgs([]),
    "-f",
    TMUX_CONFIG_PATH,
    "new-session",
    "-d",
    "-s",
    input.sessionName,
    "-c",
    input.cwd,
    ...envArgs,
  ]);
  invalidateFleetProbeCaches();
  await sleep(300);

  try {
    await sendMessageToTmux(input.sessionName, input.launchCommand, {
      ...(input.agent ? { agent: input.agent } : {}),
    });
  } catch (error) {
    try {
      await tmux("kill-session", "-t", sessionTarget);
    } catch {
      // Best effort only.
    } finally {
      invalidateFleetProbeCaches();
    }
    throw error;
  }
}

export async function createTmuxCommandSession(input: {
  sessionName: string;
  cwd: string;
  launchCommand: string;
  env?: Record<string, string>;
}): Promise<void> {
  const paneTarget = exactPaneTarget(input.sessionName);
  // Wrap in `sh -lc` without `exec` so shell builtins (cd, set, export, ...)
  // in the project's sidecar command work. With `exec`, sh tries to exec the
  // first token as a binary and a builtin-led command like `cd front && ...`
  // dies instantly with "exec: cd: not found".
  const shellCommand = `sh -lc ${shellEscape(input.launchCommand)}`;

  // Two-step launch so `remain-on-exit on` is set BEFORE the user command
  // runs. If we pass the shell-command directly to `new-session`, a command
  // that crashes on first line (bad PATH, missing binary, exec-on-builtin)
  // tears the pane down before the pane option can land — making the failure
  // invisible. `remain-on-exit` is a pane option, so set it with `-p` on the
  // pane we are about to respawn.
  await runTmuxNewSession([
    ...withTmuxSocketArgs([]),
    "-f",
    TMUX_CONFIG_PATH,
    "new-session",
    "-d",
    "-s",
    input.sessionName,
    "-c",
    input.cwd,
    ...buildEnvArgs(input.env),
  ]);
  // The detached session now exists; bust the fleet caches so a just-created
  // session is immediately visible to tmuxSessionExists/pane probes.
  invalidateFleetProbeCaches();
  await tmux("set-option", "-p", "-t", paneTarget, "remain-on-exit", "on");
  await tmux("respawn-pane", "-k", "-t", paneTarget, shellCommand);
}

async function pasteLiteral(
  sessionName: string,
  payload: string,
  bracketed = false,
): Promise<void> {
  const target = exactPaneTarget(sessionName);
  const bufferName = `spur-${randomUUID()}`;
  const tempPath = join(tmpdir(), `spur-${randomUUID()}.txt`);
  writeFileSync(tempPath, payload, { encoding: "utf-8", mode: 0o600 });
  try {
    await tmux("load-buffer", "-b", bufferName, tempPath);
    const args = ["paste-buffer", "-b", bufferName, "-t", target, "-d"];
    if (bracketed) {
      args.splice(1, 0, "-p");
    }
    await tmux(...args);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failures.
    }
    try {
      await tmux("delete-buffer", "-b", bufferName);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

async function sendLiteral(sessionName: string, message: string): Promise<void> {
  const target = exactPaneTarget(sessionName);
  if (message.includes("\n") || message.length > 200) {
    await pasteLiteral(sessionName, message);
    return;
  }

  await tmux("send-keys", "-t", target, "-l", message);
}

const DEFAULT_SUBMIT_DELAY_MS = 300;

export async function sendMessageToTmux(
  sessionName: string,
  message: string,
  options?: { interrupt?: boolean; agent?: AgentName },
): Promise<void> {
  const target = exactPaneTarget(sessionName);
  const useBracketedPaste =
    options?.agent !== undefined &&
    agentSendMode(options.agent) === "bracketed_paste" &&
    !process.env["SPUR_SKIP_CODEX_SUBMIT_ACK"];
  if (options?.interrupt) {
    await tmux("send-keys", "-t", target, "C-c");
    await sleep(500);
  }
  // Exit copy-mode before issuing line-edit keys. `-X cancel` is a no-op
  // outside copy-mode; if a user accidentally entered it (mouse drag, PageUp),
  // C-u and Enter would otherwise be interpreted by the copy buffer and never
  // reach the agent's stdin. Older tmux builds may exit non-zero here — swallow.
  await tmux("send-keys", "-t", target, "-X", "cancel").catch(() => {});
  await tmux("send-keys", "-t", target, "C-u");
  if (useBracketedPaste) {
    // Codex TUI enables bracketed paste and handles it as a distinct paste event.
    // The bash-based fake Codex runtime used in tests does not, so keep those
    // runs on plain tmux input to avoid losing the first resumed prompt send.
    // Submit with a real Enter key so delivery does not depend on newline characters
    // inside the pasted payload or on Codex's paste-burst heuristics.
    await pasteLiteral(sessionName, message, true);
    await tmux("send-keys", "-t", target, "Enter");
    return;
  }
  await sendLiteral(sessionName, message);
  await sleep(DEFAULT_SUBMIT_DELAY_MS);
  await tmux("send-keys", "-t", target, "Enter");
}

export async function sendSubmitKeyToTmux(sessionName: string): Promise<void> {
  const target = exactPaneTarget(sessionName);
  await tmux("send-keys", "-t", target, "Enter");
}

export async function waitForTmuxReady(
  sessionName: string,
  readyMarkers: string[],
  timeoutMs = 30_000,
  options?: { agent?: AgentName },
): Promise<void> {
  if (readyMarkers.length === 0) {
    await sleep(1_500);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  let lastCapture = "";
  let lastCursorTrustConfirmAt = 0;
  let cursorTrustConfirmAttempts = 0;
  while (Date.now() < deadline) {
    // fresh: this loop polls every 500ms expecting genuinely current pane
    // text (readiness detection, and the cursor trust-confirm retry gate at
    // CURSOR_TRUST_CONFIRM_DELAY_MS=1000ms) — well under the probe cache's
    // 2s TTL, so a cached read here would stall detection and could resend
    // a trust-confirm Enter against stale (already-confirmed) text.
    const capture = await captureTmuxPane(sessionName, 200, { fresh: true });
    lastCapture = capture;
    if (options?.agent === "cursor" && cursorShowsReadyPrompt(capture)) {
      if (cursorTrustConfirmAttempts > 0) {
        await sleep(CURSOR_READY_SETTLE_DELAY_MS);
      }
      return;
    }
    if (readyMarkers.every((marker) => capture.includes(marker))) {
      if (options?.agent === "codex") {
        // Codex can print its prompt before the next stdin read is ready.
        await sleep(CODEX_READY_SETTLE_DELAY_MS);
      }
      return;
    }
    if (
      options?.agent === "cursor" &&
      cursorShowsWorkspaceTrustPrompt(capture) &&
      cursorTrustConfirmAttempts < CURSOR_TRUST_CONFIRM_MAX_ATTEMPTS &&
      Date.now() - lastCursorTrustConfirmAt >= CURSOR_TRUST_CONFIRM_DELAY_MS
    ) {
      cursorTrustConfirmAttempts += 1;
      lastCursorTrustConfirmAt = Date.now();
      await sendSubmitKeyToTmux(sessionName);
      await sleep(500);
      continue;
    }
    await sleep(500);
  }

  const detail = lastCapture.trim()
    ? `\nLast pane output:\n${lastCapture.trimEnd().split("\n").slice(-40).join("\n")}`
    : "";
  throw new Error(
    `Timed out waiting for tmux session "${sessionName}" to reach the agent prompt${detail}`,
  );
}

export async function killTmuxSession(sessionName: string): Promise<void> {
  const target = exactSessionTarget(sessionName);
  try {
    await tmux("kill-session", "-t", target);
  } catch {
    // Best effort only.
  } finally {
    invalidateFleetProbeCaches();
  }
}

export function sidecarTmuxSession(sessionId: string, sidecarName: string): string {
  return `${sessionId}--${sidecarName}`;
}

export async function createTmuxSidecarSession(input: {
  sessionId: string;
  sidecarName: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
}): Promise<void> {
  await createTmuxCommandSession({
    sessionName: sidecarTmuxSession(input.sessionId, input.sidecarName),
    cwd: input.cwd,
    launchCommand: input.command,
    ...(input.env ? { env: input.env } : {}),
  });
}

export async function sidecarTmuxAlive(sessionId: string, sidecarName: string): Promise<boolean> {
  return tmuxSessionExists(sidecarTmuxSession(sessionId, sidecarName));
}

export async function killSidecarTmux(sessionId: string, sidecarName: string): Promise<void> {
  await killTmuxSession(sidecarTmuxSession(sessionId, sidecarName));
}

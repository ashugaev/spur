import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { appendFileSync, existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _resetGhPathCacheForTests } from "../../src/gh.js";
import type { RuntimeInfo, TodoProjection } from "../../src/types.js";
import { createTempDir, execFileAsync, pollUntil, processExists } from "./common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const V2_DIR = resolve(__dirname, "../..");
export const CLI_PATH = join(V2_DIR, "dist/cli.js");
// Same config the daemon loads in production. The bootstrap session cold-starts
// the isolated tmux server, so it must apply `set -g status off` server-globally
// here; otherwise later sessions inherit tmux's default `status on`.
const TMUX_CONFIG_PATH = join(V2_DIR, "tmux.conf");
const TMUX_BOOTSTRAP_SESSION = `spur-runtime-bootstrap-${process.pid}`;
let tmuxBootstrapReady = false;
let activeTmuxSocketName: string | null = null;
// Every socket this process has armed via setActiveTmuxSocketName, drained by
// killTmuxServer. The single process.once("exit") net below iterates this
// set, not just the first-registered socket — a per-context single-socket
// capture (the prior design) only ever protects the FIRST context in a file;
// every later context got no net at all.
const liveTmuxSockets = new Set<string>();
let tmuxExitNetRegistered = false;

export function setActiveTmuxSocketName(socketName: string | null): void {
  const next = socketName?.trim() || null;
  if (activeTmuxSocketName !== next) {
    tmuxBootstrapReady = false;
  }
  activeTmuxSocketName = next;
  if (next) {
    liveTmuxSockets.add(next);
  }
  if (!tmuxExitNetRegistered) {
    tmuxExitNetRegistered = true;
    const sweep = (): void => {
      for (const socket of liveTmuxSockets) {
        spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      }
    };
    process.once("exit", sweep);
    // A vitest fork-pool worker is torn down by its parent sending SIGTERM,
    // not by the worker's own event loop going idle — plain `process.once
    // ("exit", ...)` alone never fires on that path (measured: a fixture that
    // arms two sockets and returns normally still leaves both tmux servers
    // alive after the whole `vitest run` invocation exits). Translating the
    // signal into an explicit process.exit() makes the exit path uniform:
    // the "exit" listener above still does the actual kill, this only
    // ensures it gets invoked instead of the default signal disposition
    // terminating the process without emitting "exit" at all. A prior
    // listener for either signal (there is none installed in this test
    // tree) would be overridden by design — teardown safety wins here.
    process.once("SIGTERM", () => process.exit(0));
    process.once("SIGINT", () => process.exit(0));
  }
}

// Builds the `-L <socket> ...` argv this module always shapes tmux calls
// with — the one place argv is built, so a test can assert it directly
// instead of relying on "does not throw" (vacuous: killTmuxSessionsByPrefix's
// catch swallows any error either way).
export function buildTmuxSocketArgs(socketName: string, args: string[]): string[] {
  return ["-L", socketName, ...args];
}

// Test-only: exercises the armed-socket tracking set directly.
export const _liveTmuxSocketsForTests = liveTmuxSockets;

// spawnSync + kill-server, then drop the socket from the tracked set so a
// later exit-net pass never double-kills an already-torn-down server.
export function killTmuxServer(socketName: string): void {
  spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
  liveTmuxSockets.delete(socketName);
}

export function withTmuxSocket(args: string[]): string[] {
  if (activeTmuxSocketName === null) {
    throw new Error(
      "no isolated tmux socket active; createRuntimeTestContext or setActiveTmuxSocketName must run first",
    );
  }
  return buildTmuxSocketArgs(activeTmuxSocketName, args);
}

export interface FakeGhState {
  prsByBranch?: Record<
    string,
    {
      number: number;
      title: string;
      url: string;
      reviewDecision?: string | null;
      mergeable?: string | null;
      mergeStateStatus?: string | null;
      repo?: string;
      state?: string | null;
      closed?: boolean | null;
      closedAt?: string | null;
      mergedAt?: string | null;
    }
  >;
  prsByNumber?: Record<
    string,
    {
      number: number;
      title: string;
      url: string;
      reviewDecision?: string | null;
      mergeable?: string | null;
      mergeStateStatus?: string | null;
      repo?: string;
      state?: string | null;
      closed?: boolean | null;
      closedAt?: string | null;
      mergedAt?: string | null;
    }
  >;
  checksByPr?: Record<string, Array<{ name: string; state: string }>>;
  commentsByPr?: Record<
    string,
    Array<{ id: number; body: string; html_url?: string; user?: { login?: string | null } }>
  >;
  reviewCommentsByPr?: Record<
    string,
    Array<{
      id: number;
      body: string;
      path?: string | null;
      line?: number | null;
      user?: { login?: string | null };
    }>
  >;
  reviewsByPr?: Record<string, Array<{ state?: string | null; user?: { login?: string | null } }>>;
  reviewThreadsByPr?: Record<string, Array<Record<string, unknown>>>;
  searchPrs?: Array<{
    number: number;
    title: string;
    url: string;
    repository: { nameWithOwner: string };
  }>;
}

export interface RuntimeTestContext {
  rootDir: string;
  repoDir: string;
  originDir: string;
  dataDir: string;
  worktreeDir: string;
  fakeBinDir: string;
  agentLogDir: string;
  ghStateFile: string;
  port: number;
  tmuxSocketName: string;
  env: NodeJS.ProcessEnv;
  writeConfig(name: string, content: string): Promise<string>;
  execCli(
    args: string[],
    options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string }>;
  startDaemon(configPath: string): Promise<{
    child: ChildProcessByStdio<null, Readable, Readable>;
    stdout: string;
    info: RuntimeInfo;
  }>;
  stopDaemon(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void>;
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
  readAgentLog(sessionId: string): Promise<string>;
  writeGhState(state: FakeGhState): Promise<void>;
  cleanup(): Promise<void>;
}

// The fake agent fixture backgrounds its "add then complete" ToDo round trip
// (record_fixture_todo, see the FAKE_AGENT_SCRIPT body below) so it never
// blocks the session's workspace lock. That means the fixture item can still
// be open for a window after the daemon reports the session "waiting" — a
// caller that fires a ledger-gated manual status (e.g. `complete`) right
// after spawn/resume can hit `todo_open_work` (PR #781 regression, see
// GitHub Actions run 33044875236). Poll the session's ToDo projection until
// it has no open or held items before issuing the gated call.
export async function waitForCleanTodoLedger(
  context: RuntimeTestContext,
  sessionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 15_000 } = opts;
  await pollUntil(async () => context.fetchJson<TodoProjection>(`/sessions/${sessionId}/todo`), {
    timeoutMs,
    accept: (projection) => projection.counts.open === 0 && projection.counts.held === 0,
    label: `clean Spur ToDo ledger for session ${sessionId}`,
  });
}

export function fakeAgentScript(
  agentName: "claude" | "codex" | "cursor",
  options?: { hupResistant?: boolean },
): string {
  // Opt-in only: real agents don't ignore SIGHUP, and the terminate-then-
  // confirm guard's own default grace windows assume it lands. This exists
  // solely so a runtime test can force the SIGKILL path deterministically.
  const hupTrap = options?.hupResistant ? "\ntrap '' HUP" : "";
  const header =
    agentName === "claude"
      ? "Claude Code"
      : agentName === "codex"
        ? "OpenAI Codex"
        : "Cursor Agent";
  const prompt = agentName === "claude" ? "❯" : agentName === "codex" ? "›" : "Composer 2 Fast";
  const startup =
    agentName === "claude"
      ? `if [[ "\${1:-}" == "--print" ]]; then
  if printf '%s' "$*" | grep -q "empty preflight output"; then
    exit 0
  fi
  branch_hint="$(printf '%s' "$*" | sed -n 's/.*branch hint: \\([^[:space:]]*\\).*/\\1/p' | head -n 1)"
  retry_branch_hint="$(printf '%s' "$*" | sed -n 's/.*retry branch hint: \\([^[:space:]]*\\).*/\\1/p' | head -n 1)"
  if printf '%s' "$*" | grep -q "Previous attempt feedback:" && [[ -n "$retry_branch_hint" ]]; then
    branch_hint="$retry_branch_hint"
  fi
  if [[ -n "$branch_hint" ]]; then
    printf '%s\n' "$branch_hint"
  else
    printf 'NO_PROJECT_RULES\n'
  fi
  exit 0
fi
# Real claude is a TUI that treats Ctrl-C as "cancel current input", not
# "kill the process" — an interrupt-delivered trigger send (e.g. a restored
# session's redelivered merge-conflict alert) relies on the agent surviving
# the leading C-c in sendMessageToTmux. Without this trap the default SIGINT
# action kills the script, so the interrupt drops the process instead of
# just clearing its input line, and the send never reaches the read loop.
trap '' INT${hupTrap}
mode="launch"
resume_id=""
pinned_session_id=""
args=("$@")
for ((index = 0; index < \${#args[@]}; index++)); do
  if [[ "\${args[$index]}" == "--session-id" ]]; then
    next_index=$((index + 1))
    pinned_session_id="\${args[$next_index]:-}"
    break
  fi
done
encoded_path=$(printf '%s' "$PWD" | tr '\\\\' '/' | sed 's/://g; s/[/.]/-/g')
session_dir="$HOME/.claude/projects/$encoded_path"
mkdir -p "$session_dir"
if [[ "\${1:-}" == "--resume" ]]; then
  mode="resume"
  resume_id="\${2:-}"
  session_uuid="$resume_id"
  # Resumed sessions append to the existing JSONL file written during launch.
  if [[ ! -f "$session_dir/$session_uuid.jsonl" ]]; then
    printf '{"type":"session"}\n' > "$session_dir/$session_uuid.jsonl"
  fi
else
  # Real claude names its transcript after --session-id when the caller pins
  # one (Spur passes this on every launch); mirror that so sessionFileForId
  # can find it by the pinned id instead of falling through to a fresh launch.
  # pinned_session_id is parsed once above, before the resume/launch branch.
  # Divergence to know about: this fake writes the file at launch, while real
  # claude creates it only when it persists the first submitted message. That
  # is why runtime tests never saw the launch send's missing submit ack, which
  # loses pipeline step 1 whenever the claude TUI swallows the submit Enter.
  if [[ -n "$pinned_session_id" ]]; then
    session_uuid="$pinned_session_id"
  else
    session_uuid="fake-claude-\${SPUR_SESSION:-no-session}"
  fi
  printf '{"type":"session"}\n' > "$session_dir/$session_uuid.jsonl"
fi
jsonl_append() {
  if [[ -n "\${session_dir:-}" ]] && [[ -n "\${session_uuid:-}" ]]; then
    printf '%s\n' "$1" >> "$session_dir/$session_uuid.jsonl"
  fi
}`
      : agentName === "codex"
        ? `if [[ "\${1:-}" == "exec" ]]; then
  output_file=""
  args=("$@")
  for ((index = 0; index < \${#args[@]}; index++)); do
    if [[ "\${args[$index]}" == "--output-last-message" || "\${args[$index]}" == "-o" ]]; then
      next_index=$((index + 1))
      output_file="\${args[$next_index]:-}"
      break
    fi
  done
  preflight_input="$*"
  if [[ "\${args[\${#args[@]}-1]:-}" == "-" ]]; then
    preflight_input="$(cat)"
  fi
  if printf '%s' "$preflight_input" | grep -q "empty preflight output"; then
    if [[ -n "$output_file" ]]; then
      : > "$output_file"
    fi
    exit 0
  fi
  branch_hint="$(printf '%s' "$preflight_input" | sed -n 's/.*branch hint: \\([^[:space:]]*\\).*/\\1/p' | head -n 1)"
  retry_branch_hint="$(printf '%s' "$preflight_input" | sed -n 's/.*retry branch hint: \\([^[:space:]]*\\).*/\\1/p' | head -n 1)"
  if printf '%s' "$preflight_input" | grep -q "Previous attempt feedback:" && [[ -n "$retry_branch_hint" ]]; then
    branch_hint="$retry_branch_hint"
  fi
  payload='NO_PROJECT_RULES'
  if [[ -n "$branch_hint" ]]; then
    payload="$branch_hint"
  fi
  if [[ -n "$output_file" ]]; then
    printf '%s\n' "$payload" > "$output_file"
  else
    printf '%s\n' "$payload"
  fi
  exit 0
fi
codex_base="\${CODEX_HOME:-$HOME/.codex}"
session_dir="$codex_base/sessions/2026/03/18"
session_rollout="$session_dir/rollout-\${SPUR_SESSION:-no-session}.jsonl"
find_rollout_by_thread_id() {
  local sessions_root="$1"
  local wanted_thread_id="$2"
  if [[ -z "$wanted_thread_id" ]] || [[ ! -d "$sessions_root" ]]; then
    return 0
  fi
  python3 - "$sessions_root" "$wanted_thread_id" <<'PY'
import json
import os
import sys

sessions_root, wanted_thread_id = sys.argv[1], sys.argv[2]
best_key = None
best_path = ""

for root, _, files in os.walk(sessions_root):
    for name in files:
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(root, name)
        thread_id = None
        try:
            with open(path, encoding="utf-8") as handle:
                for _ in range(10):
                    line = handle.readline()
                    if not line:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        parsed = json.loads(line)
                    except Exception:
                        continue
                    if isinstance(parsed, dict):
                        value = parsed.get("threadId")
                        if isinstance(value, str) and value:
                            thread_id = value
                            break
        except OSError:
            continue
        if thread_id != wanted_thread_id:
            continue
        try:
            stat_result = os.stat(path)
        except OSError:
            continue
        key = (stat_result.st_mtime_ns, path)
        if best_key is None or key > best_key:
            best_key = key
            best_path = path

sys.stdout.write(best_path)
PY
}
mode="launch"
resume_id=""
thread_id="thread-\${SPUR_SESSION:-no-session}"
if [[ "\${1:-}" == "resume" ]]; then
  mode="resume"
  resume_id="\${@: -1}"
  thread_id="\${resume_id:-$thread_id}"
  existing_rollout="$(find_rollout_by_thread_id "$codex_base/sessions" "$thread_id")"
  if [[ -n "$existing_rollout" ]]; then
    session_rollout="$existing_rollout"
  fi
fi
mkdir -p "$session_dir"
if [[ "$mode" != "resume" || ! -f "$session_rollout" ]]; then
  printf '{"type":"session_meta","cwd":"%s","model":"test-model"}\n' "$PWD" > "$session_rollout"
  printf '{"threadId":"%s"}\n' "$thread_id" >> "$session_rollout"
fi`
        : `if [[ "\${1:-}" == "-p" || "\${1:-}" == "--print" ]]; then
  branch_hint="$(printf '%s' "$*" | sed -n 's/.*branch hint: \\([^[:space:]]*\\).*/\\1/p' | head -n 1)"
  retry_branch_hint="$(printf '%s' "$*" | sed -n 's/.*retry branch hint: \\([^[:space:]]*\\).*/\\1/p' | head -n 1)"
  if printf '%s' "$*" | grep -q "Previous attempt feedback:" && [[ -n "$retry_branch_hint" ]]; then
    branch_hint="$retry_branch_hint"
  fi
  if [[ -n "$branch_hint" ]]; then
    printf '%s\n' "$branch_hint"
  else
    printf 'NO_PROJECT_RULES\n'
  fi
  exit 0
fi
if [[ "\${1:-}" == "models" ]]; then
  printf 'auto - Auto\n'
  printf 'composer-2.5 - Composer 2.5 (current)\n'
  printf 'composer-2.5-fast - Composer 2.5 Fast (default)\n'
  exit 0
fi
cursor_base="\${CURSOR_CONFIG_DIR:-$HOME/.cursor}"
workspace_hash="$(node -e 'const { createHash } = require("node:crypto"); const { resolve } = require("node:path"); process.stdout.write(createHash("md5").update(resolve(process.argv[1])).digest("hex"));' "$PWD")"
cursor_project_slug="$(printf '%s' "$PWD" | tr '\\\\' '/' | sed 's/^\\/\\+//; s/\\.//g; s/\\//-/g')"
touch_chat_store() {
  local chat_id="$1"
  local chat_dir="$cursor_base/chats/$workspace_hash/$chat_id"
  mkdir -p "$chat_dir"
  printf 'cursor-session\n' > "$chat_dir/store.db"
}
jsonl_append() {
  if [[ -n "\${transcript_file:-}" ]]; then
    printf '%s\\n' "$1" >> "$transcript_file"
  fi
}
if [[ "\${1:-}" == "create-chat" ]]; then
  chat_id="chat-\${SPUR_SESSION:-manual}"
  touch_chat_store "$chat_id"
  printf '%s\n' "$chat_id"
  exit 0
fi
mode="launch"
resume_id=""
chat_id="chat-\${SPUR_SESSION:-no-session}"
if [[ "\${1:-}" == "--resume" ]]; then
  mode="resume"
  resume_id="\${2:-}"
  chat_id="$resume_id"
fi
touch_chat_store "$chat_id"
transcript_dir="$HOME/.cursor/projects/$cursor_project_slug/agent-transcripts/$chat_id"
mkdir -p "$transcript_dir"
transcript_file="$transcript_dir/$chat_id.jsonl"
if [[ "$mode" == "resume" && -f "$transcript_file" ]]; then
  :
else
  printf '{"role":"assistant","message":{"content":[{"type":"text","text":"ready"}]}}\\n' > "$transcript_file"
fi`;
  // State signal helpers — Claude writes JSONL records, Codex writes hook state
  // plus structured rollout events for question/waiting metadata.
  const signalWaiting =
    agentName === "claude"
      ? `jsonl_append '{"type":"assistant","message":{"role":"assistant","content":[],"stop_reason":"end_turn"}}'`
      : agentName === "codex"
        ? `emit_hook_event "Stop"`
        : `jsonl_append '{"role":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'`;
  const signalNeedsInput =
    agentName === "claude"
      ? `jsonl_append '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"header":"Plan","question":"Which tier should I run next?","options":[{"label":"fast","description":"Run fast tests first"},{"label":"runtime","description":"Run runtime integration next"}]}]}}]}}'`
      : agentName === "codex"
        ? `emit_hook_needs_input
      emit_rollout_input_required`
        : `jsonl_append '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion","input":{}}]}}'`;
  const signalSlowToolResult =
    agentName === "claude"
      ? `jsonl_append '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","input":{"timeout":6000}}]}}'
      sleep 5
      jsonl_append '{"type":"user","message":{"role":"user","content":[{"type":"tool_result"}]}}'
      printf '%s\\n' "${prompt}"
      ${signalWaiting}`
      : `printf '%s\\n' "ack: slow tool"
      printf '%s\\n' "${prompt}"
      ${signalWaiting}`;
  // Fake agents buffer pasted multi-line input and write one user record with
  // the full message, matching the submit-ack scanners' production boundary.
  const claudeEmitBuffered = `if [[ -n "\${session_dir:-}" && -n "\${session_uuid:-}" ]]; then
    encoded_text="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$full_msg")"
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":%s}]},"timestamp":"%s","sessionId":"%s"}\\n' "$encoded_text" "$timestamp" "$session_uuid" >> "$session_dir/$session_uuid.jsonl"
  fi`;
  // Codex uses a buffering read loop that drains pasted lines before emitting
  // one event_msg entry at submit time, so scanCodexRolloutForMessage sees
  // the exact full restore/replay message even across interrupt-driven sends.
  const codexEmitBuffered = `if [[ -n "\${SPUR_SESSION:-}" && -n "\${session_rollout:-}" ]]; then
    printf '{"type":"event_msg","payload":{"type":"user_message","message":%s}}\\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$full_msg")" >> "$session_rollout"
  fi
  emit_hook_event "UserPromptSubmit"`;
  const cursorEmitBuffered = `if [[ -n "\${transcript_file:-}" ]]; then
    encoded_text="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$full_msg")"
    printf '{"role":"user","message":{"content":[{"type":"text","text":%s}]}}\\n' "$encoded_text" >> "$transcript_file"
  fi`;
  const readLoop =
    agentName === "claude"
      ? `while IFS= read -r line; do
  full_msg="$line"
  dispatch_line="$line"
  printf '%s\\n' "$line" >> "$log_file"
  # Drain remaining lines from the same paste. Daemon sends paste then sleeps
  # DEFAULT_SUBMIT_DELAY_MS (300ms) before the submit Enter; drain must exceed
  # that so we capture the full message before emitting the JSONL ack record.
  while IFS= read -r -t 0.5 extra; do
    full_msg="$full_msg
$extra"
    if [[ -n "$extra" ]]; then
      dispatch_line="$extra"
    fi
    printf '%s\\n' "$extra" >> "$log_file"
  done
  ${claudeEmitBuffered}
  case "$dispatch_line" in
    show-waiting-menu)
      ${signalNeedsInput}
      printf '%s\\n' "Entered plan mode"
      printf '%s\\n' "1. fast"
      printf '%s\\n' "2. runtime"
      printf '%s\\n' "Enter to select"
      printf '%s\\n' "Esc to cancel"
      ;;
    slow-tool-result)
      ${signalSlowToolResult}
      ;;
    simulate-work)
      printf '%s\\n' "• Working (simulated)"
      sleep 1
      printf '%s\\n' "${prompt}"
      ${signalWaiting}
      ;;
    exit-now)
      exit 0
      ;;
    *)
      printf '%s\\n' "ack: $line"
      printf '%s\\n' "${prompt}"
      ${signalWaiting}
      ;;
  esac
done`
      : agentName === "codex"
        ? `trap '' INT${hupTrap}
codex_paste_start=$'\\e[200~'
codex_paste_end=$'\\e[201~'
codex_buffer=""
codex_in_paste=0
codex_handle_message() {
  local submitted_msg="$1"
  if [[ -z "$submitted_msg" ]]; then
    return
  fi
  full_msg="$submitted_msg"
  ${codexEmitBuffered}
  case "$submitted_msg" in
    show-waiting-menu)
      ${signalNeedsInput}
      printf '%s\\n' "Entered plan mode"
      printf '%s\\n' "1. fast"
      printf '%s\\n' "2. runtime"
      printf '%s\\n' "Enter to select"
      printf '%s\\n' "Esc to cancel"
      ;;
    simulate-work)
      printf '%s\\n' "• Working (simulated)"
      sleep 1
      printf '%s\\n' "${prompt}"
      ${signalWaiting}
      ;;
    exit-now)
      exit 0
      ;;
    *)
      printf '%s\\n' "ack: $submitted_msg"
      printf '%s\\n' "${prompt}"
      ${signalWaiting}
      ;;
  esac
}
codex_append_line() {
  local next_line="$1"
  if [[ -z "$next_line" ]]; then
    return
  fi
  if [[ -n "$codex_buffer" ]]; then
    codex_buffer="$codex_buffer
$next_line"
    return
  fi
  codex_buffer="$next_line"
}
codex_process_line() {
  local current_line="$1"
  current_line="\${current_line//$'\\r'/}"
  current_line="\${current_line//$'\\003'/}"
  if [[ -z "$current_line" && $codex_in_paste -eq 0 ]]; then
    return
  fi
  if [[ $codex_in_paste -eq 1 ]]; then
    if [[ "$current_line" == *"$codex_paste_end"* ]]; then
      local before_end="\${current_line%%"$codex_paste_end"*}"
      local after_end="\${current_line#*"$codex_paste_end"}"
      codex_append_line "$before_end"
      codex_in_paste=0
      local submitted_msg="$codex_buffer"
      codex_buffer=""
      codex_handle_message "$submitted_msg"
      if [[ -n "$after_end" ]]; then
        codex_process_line "$after_end"
      fi
      return
    fi
    codex_append_line "$current_line"
    return
  fi
  if [[ "$current_line" == *"$codex_paste_start"* ]]; then
    codex_in_paste=1
    codex_buffer=""
    codex_process_line "\${current_line#*"$codex_paste_start"}"
    return
  fi
  codex_handle_message "$current_line"
}
while true; do
  line=""
  if ! IFS= read -r line; then
    if [[ -z "$line" ]]; then
      continue
    fi
  fi
  chunk="$line"
  printf '%s\\n' "$line" >> "$log_file"
  # Tmux can still split a single submit across multiple immediate reads.
  # Drain the pending burst so fake Codex emits one exact rollout ack row.
  while IFS= read -r -t 0.05 extra; do
    chunk="$chunk
$extra"
    printf '%s\\n' "$extra" >> "$log_file"
  done
  codex_process_line "$chunk"
done`
        : `while IFS= read -r line; do
  full_msg="$line"
  printf '%s\\n' "$line" >> "$log_file"
  # Cursor records one user turn for the submitted message. Drain a pasted
  # multi-line message through its delayed submit Enter before writing it.
  while IFS= read -r -t 0.5 extra; do
    full_msg="$full_msg
$extra"
    printf '%s\\n' "$extra" >> "$log_file"
  done
  ${cursorEmitBuffered}
  touch_chat_store "$chat_id"
  case "$line" in
    show-waiting-menu)
      ${signalNeedsInput}
      printf '%s\\n' "Entered plan mode"
      printf '%s\\n' "1. fast"
      printf '%s\\n' "2. runtime"
      printf '%s\\n' "Enter to select"
      printf '%s\\n' "Esc to cancel"
      ;;
    simulate-work)
      jsonl_append '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Shell","input":{}}]}}'
      printf '%s\\n' "• Working (simulated)"
      sleep 1
      printf '%s\\n' "${prompt}"
      ${signalWaiting}
      ;;
    exit-now)
      exit 0
      ;;
    *)
      printf '%s\\n' "ack: $line"
      printf '%s\\n' "${prompt}"
      ${signalWaiting}
      ;;
  esac
done`;
  return `#!/usr/bin/env bash
set -euo pipefail
log_dir="\${SPUR_FAKE_AGENT_LOG_DIR:?missing SPUR_FAKE_AGENT_LOG_DIR}"
mkdir -p "$log_dir"
log_file="$log_dir/\${SPUR_SESSION:-no-session}.log"
${startup}
hook_seq=0
emit_hook_event() {
  local event_name="$1"
  hook_seq=$((hook_seq + 1))
  printf '{"hook_event_name":"%s","turn_id":"%s-%s"}' "$event_name" "\${SPUR_SESSION:-no-session}" "$hook_seq" | "$SPUR_AGENT_STATE_COMMAND" 2>/dev/null || true
}
emit_hook_needs_input() {
  hook_seq=$((hook_seq + 1))
  local turn_id="\${SPUR_SESSION:-no-session}-$hook_seq"
  printf '{"hook_event_name":"NeedsInput","turn_id":"%s","state":"needs_input","questions":[{"header":"Plan","question":"Which tier should I run next?","options":[{"label":"fast","description":"Run fast tests first"},{"label":"runtime","description":"Run runtime integration next"}]}]}' "$turn_id" | "$SPUR_AGENT_STATE_COMMAND" 2>/dev/null || true
}
emit_rollout_input_required() {
  if [[ -z "\${session_rollout:-}" ]]; then
    return
  fi
  printf '{"type":"event_msg","payload":{"type":"input_required","turn_id":"%s","questions":[{"header":"Plan","question":"Which tier should I run next?","options":[{"label":"fast","description":"Run fast tests first"},{"label":"runtime","description":"Run runtime integration next"}]}]}}\\n' "\${SPUR_SESSION:-no-session}-$hook_seq" >> "$session_rollout"
}
record_fixture_todo() {
  if [[ -z "\${SPUR_TODO_COMMAND:-}" ]]; then
    return
  fi
  # Idempotent: a resumed/restored process re-runs this startup script, but the
  # fixture item is a one-time "the agent touched ToDo" marker, not a per-launch
  # step. Re-adding on every relaunch races a caller polling for a clean ledger
  # right after a resume (see cli-lifecycle.runtime.test.ts pause/resume/complete).
  #
  # Status-aware, not status-blind: a pause can kill this backgrounded script
  # between "add" and "complete", leaving the item open forever with no future
  # relaunch able to see that and heal it (a text-only guard would just skip
  # re-adding and never complete it). So report id+status, only skip on a
  # terminal status, and reuse the existing id to complete an open/held one.
  local existing_id existing_status
  existing_id=""
  existing_status=""
  read -r existing_id existing_status < <("$SPUR_TODO_COMMAND" list --json 2>/dev/null | python3 -c 'import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(" ")
else:
    item = next((i for i in data.get("items", []) if i.get("text") == "Fixture step"), None)
    print((item.get("id", "") + " " + item.get("status", "")) if item else " ")' 2>/dev/null || printf ' ')
  if [[ "$existing_status" == "completed" || "$existing_status" == "cancelled" ]]; then
    return
  fi
  local todo_id="$existing_id"
  if [[ -z "$todo_id" ]]; then
    todo_id="$("$SPUR_TODO_COMMAND" add --text "Fixture step" --reason "Runtime agent fixture step" --json 2>/dev/null | python3 -c 'import json,sys; data=json.load(sys.stdin); print(next((item["id"] for item in data["items"] if item["status"] == "open"), ""))' 2>/dev/null || true)"
  fi
  if [[ -n "$todo_id" ]]; then
    local attempt
    for attempt in 1 2 3; do
      if SPUR_DISABLE_AUTOSTART=1 "$SPUR_TODO_COMMAND" complete "$todo_id" --reason "Resolved by the runtime agent fixture" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
  fi
}
printf '%s\n' "startup:$mode:$resume_id:$*" >> "$log_file"
printf '%s\n' "${header}"
printf '%s\n' "${prompt}"
# Backgrounded: a resume/wake triggered by send() holds the session's
# workspace lock for the whole submit-ack wait, and every SPUR_TODO_COMMAND
# call below re-enters that same lock. Run synchronously here and a
# resume-via-send deadlocks — the daemon waits for this script to reach
# signalWaiting/the read loop (which is what satisfies the ack), while this
# script is blocked waiting for the lock the daemon is holding. Backgrounding
# lets startup reach signalWaiting immediately; the fixture add/complete
# round trip then completes once the ack is found and the lock releases.
record_fixture_todo &
${signalWaiting}
${readLoop}
`;
}

const FAKE_GH_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");

function readState() {
  const path = process.env.SPUR_FAKE_GH_STATE_FILE;
  if (!path || !fs.existsSync(path)) return {};
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function print(value) {
  process.stdout.write(JSON.stringify(value));
}

function argValue(args, prefix) {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function connection(nodes) {
  return { nodes, pageInfo: { hasPreviousPage: false, startCursor: null } };
}

function prFromNumber(state, prNumber) {
  return (
    state.prsByNumber?.[String(prNumber)] ||
    Object.values(state.prsByBranch || {}).find(
      (value) => String(value?.number || "") === String(prNumber),
    )
  );
}

function pullRequestNode(state, pr) {
  if (!pr) return null;
  const prNumber = String(pr.number || "");
  const checks = (state.checksByPr?.[prNumber] || []).map((check) => ({
    name: check.name,
    conclusion: check.state,
    status: check.state === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
  }));
  const issueComments = (state.commentsByPr?.[prNumber] || []).map((comment) => ({
    databaseId: comment.id,
    body: comment.body,
    author: comment.user || null,
  }));
  const reviews = (state.reviewsByPr?.[prNumber] || []).map((review, index) => ({
    databaseId: index + 1,
    state: review.state || null,
    body: "",
    author: review.user || null,
  }));
  const reviewComments = (state.reviewCommentsByPr?.[prNumber] || []).map((comment) => ({
    databaseId: comment.id,
    body: comment.body,
    path: comment.path || null,
    line: comment.line || null,
    author: comment.user || null,
  }));
  const reviewThreads = state.reviewThreadsByPr?.[prNumber] ||
    (reviewComments.length > 0
      ? [{ id: "THREAD_" + prNumber, isResolved: false, comments: connection(reviewComments) }]
      : []);
  return {
    id: "PR_" + prNumber,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    reviewDecision: pr.reviewDecision || null,
    mergeable: pr.mergeable || "MERGEABLE",
    mergeStateStatus: pr.mergeStateStatus || "CLEAN",
    isDraft: false,
    state: pr.state || "OPEN",
    commits: {
      nodes: [{ commit: { statusCheckRollup: { contexts: connection(checks) } } }],
    },
    reviewThreads: connection(reviewThreads),
    reviews: connection(reviews),
    comments: connection(issueComments),
  };
}

const state = readState();
const args = process.argv.slice(2);

if (args[0] === "search" && args[1] === "prs") {
  print(state.searchPrs || []);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  const headIndex = args.indexOf("--head");
  const branch = headIndex === -1 ? "" : args[headIndex + 1] || "";
  const pr = state.prsByBranch?.[branch];
  print(pr ? [pr] : []);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "checks") {
  print(state.checksByPr?.[String(args[2] || "")] || []);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const prNumber = String(args[2] || "");
  const pr =
    state.prsByNumber?.[prNumber] ||
    Object.values(state.prsByBranch || {}).find((value) => String(value?.number || "") === prNumber);
  if (!pr) {
    process.stderr.write("unknown fake gh pr view target: " + prNumber + "\\n");
    process.exit(1);
  }
  print(pr);
  process.exit(0);
}

if (args[0] === "api" && args.includes("graphql")) {
  const query = argValue(args, "query=") || "";
  const repository = {
    nameWithOwner: (argValue(args, "owner=") || "acme") + "/" + (argValue(args, "name=") || "api"),
    isFork: false,
    parent: null,
  };
  for (const arg of args) {
    const numberMatch = arg.match(/^n(\\d+)=(\\d+)$/);
    if (numberMatch) {
      repository["a" + numberMatch[1]] = pullRequestNode(
        state,
        prFromNumber(state, numberMatch[2]),
      );
      continue;
    }
    const branchMatch = arg.match(/^b(\\d+)=(.*)$/s);
    if (branchMatch) {
      const node = pullRequestNode(state, state.prsByBranch?.[branchMatch[2]]);
      repository["a" + branchMatch[1]] = connection(node ? [node] : []);
    }
  }
  if (/r\\s*:\\s*repository/.test(query)) {
    print({
      data: {
        rateLimit: { cost: 1, remaining: 4900, resetAt: "2099-01-01T00:00:00.000Z" },
        r: repository,
      },
    });
    process.exit(0);
  }
  const prNumber = argValue(args, "number=");
  print({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: state.reviewThreadsByPr?.[String(prNumber || "")] || [],
          },
        },
      },
    },
  });
  process.exit(0);
}

if (args[0] === "api" && typeof args[1] === "string") {
  const reviewCommentMatch = args[1].match(/pulls\\/(\\d+)\\/comments/);
  if (reviewCommentMatch) {
    print(state.reviewCommentsByPr?.[reviewCommentMatch[1]] || []);
    process.exit(0);
  }

  const reviewsMatch = args[1].match(/pulls\\/(\\d+)\\/reviews/);
  if (reviewsMatch) {
    print(state.reviewsByPr?.[reviewsMatch[1]] || []);
    process.exit(0);
  }

  const match = args[1].match(/issues\\/(\\d+)\\/comments/);
  if (match) {
    print(state.commentsByPr?.[match[1]] || []);
    process.exit(0);
  }
}

process.stderr.write("unsupported fake gh args: " + args.join(" ") + "\\n");
process.exit(1);
`;

async function startTmuxServer(): Promise<void> {
  if (tmuxBootstrapReady) return;

  try {
    await execFileAsync("tmux", withTmuxSocket(["has-session", "-t", TMUX_BOOTSTRAP_SESSION]));
    tmuxBootstrapReady = true;
    if (activeTmuxSocketName) await recordTmuxServer(activeTmuxSocketName);
    return;
  } catch {
    // Fall through and create a bootstrap session when no server is live yet.
  }

  try {
    await execFileAsync("tmux", [
      ...withTmuxSocket([]),
      "-f",
      TMUX_CONFIG_PATH,
      "new-session",
      "-d",
      "-s",
      TMUX_BOOTSTRAP_SESSION,
      "-x",
      "1",
      "-y",
      "1",
      "sleep 3600",
    ]);
    tmuxBootstrapReady = true;
    if (activeTmuxSocketName) await recordTmuxServer(activeTmuxSocketName);
  } catch {
    // Best effort only.
  }
}

// Appends {socketName, serverPid} to the per-run ledger at
// SPUR_TEST_TMUX_LEDGER (armed by test/setup/tmux-ledger.ts's globalSetup on
// the runtime/smoke configs; unset and a no-op on the fast tier). No `ps`, no
// socket-name matching — only a live server this call itself just confirmed
// gets its pid recorded, and the pid is used later only as an identity gate
// before a kill, never as a signal target.
export async function recordTmuxServer(socketName: string): Promise<void> {
  const ledgerPath = process.env["SPUR_TEST_TMUX_LEDGER"];
  if (!ledgerPath) return;
  let serverPid: string;
  try {
    const { stdout } = await execFileAsync("tmux", [
      "-L",
      socketName,
      "display-message",
      "-p",
      "#{pid}",
    ]);
    serverPid = stdout.trim();
  } catch {
    return;
  }
  if (!serverPid) return;
  appendFileSync(ledgerPath, `${JSON.stringify({ socketName, serverPid })}\n`, "utf8");
}

export async function isTmuxAvailable(): Promise<boolean> {
  // Version probe is socket-independent and runs before any isolated socket is
  // active, so it must not go through the withTmuxSocket guard.
  try {
    await execFileAsync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

export async function syncTmuxEnvironment(env: Record<string, string | undefined>): Promise<void> {
  await startTmuxServer();
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    await execFileAsync("tmux", withTmuxSocket(["set-environment", "-g", key, value]));
  }
}

export async function createTmuxSession(args: {
  sessionName: string;
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  const tmuxArgs = ["new-session", "-d", "-s", args.sessionName, "-x", "200", "-y", "50"];
  for (const [key, value] of Object.entries(args.env ?? {})) {
    if (!value) continue;
    tmuxArgs.push("-e", `${key}=${value}`);
  }
  tmuxArgs.push(args.command);
  await execFileAsync("tmux", withTmuxSocket(tmuxArgs), { cwd: args.cwd });
}

export async function captureTmuxPane(sessionName: string, lines = 80): Promise<string> {
  try {
    // `-J` joins soft-wrapped lines back into one logical line. Without it, a
    // long prompt line that happens to wrap exactly mid-word (e.g. "This"
    // splitting into "Thi\ns" at the pane's fixed column width) can break a
    // plain `.includes()` match on assertion text that spans the wrap point —
    // a false negative unrelated to whether the text is actually present.
    const { stdout } = await execFileAsync(
      "tmux",
      withTmuxSocket(["capture-pane", "-t", sessionName, "-p", "-J", "-S", `-${lines}`]),
    );
    return stdout;
  } catch {
    return "";
  }
}

// Resolves the effective value of a tmux format variable for a session, honoring
// global defaults (e.g. `set -g status off` in tmux.conf) that `show-options`
// without `-g` does not surface at the session scope.
export async function readTmuxStatus(sessionName: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    withTmuxSocket(["display-message", "-t", sessionName, "-p", "#{status}"]),
  );
  return stdout.trim();
}

export async function execTmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("tmux", withTmuxSocket(args));
  return { stdout, stderr };
}

export async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await execTmux(["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

export async function sendKeysToTmux(sessionName: string, ...keys: string[]): Promise<void> {
  await execFileAsync("tmux", withTmuxSocket(["send-keys", "-t", sessionName, ...keys]));
}

// Stops a daemon by pid and awaits its actual exit before returning. Teardown
// must not fire-and-forget: the daemon's async shutdown can otherwise still hold
// its port / write rootDir while the next test allocates a port, causing
// order-dependent EADDRINUSE / info-poll flake. Bounded graceful window keeps us
// under the afterEach hookTimeout, with SIGKILL escalation as a backstop.
export async function stopDaemonByPid(pid?: number): Promise<void> {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const stillAlive = await pollUntil(() => processExists(pid), {
    timeoutMs: 20_000,
    intervalMs: 200,
    accept: (alive) => alive === false,
  });
  if (stillAlive === false) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  const killed = await pollUntil(() => processExists(pid), {
    timeoutMs: 5_000,
    intervalMs: 200,
    accept: (alive) => alive === false,
  });
  if (killed !== false) {
    throw new Error(`stopDaemonByPid: pid ${pid} still alive after SIGKILL`);
  }
}

// `socketName` optional: an explicit socket (used by killTmuxSessionsByPrefix)
// targets that socket directly; omitted, it falls back to the armed global
// via withTmuxSocket — every other call site in this test tree relies on
// that implicit-global form.
export async function killTmuxSession(sessionName: string, socketName?: string): Promise<void> {
  try {
    const args = socketName
      ? buildTmuxSocketArgs(socketName, ["kill-session", "-t", sessionName])
      : withTmuxSocket(["kill-session", "-t", sessionName]);
    await execFileAsync("tmux", args);
  } catch {
    // Already gone.
  }
}

export async function killTmuxSessionsByPrefix(prefix: string, socketName: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      buildTmuxSocketArgs(socketName, ["list-sessions", "-F", "#{session_name}"]),
    );
    const sessions = stdout
      .trim()
      .split("\n")
      .map((session) => session.trim())
      .filter((session) => session.startsWith(prefix));
    for (const session of sessions) {
      await killTmuxSession(session, socketName);
    }
  } catch {
    // No tmux server or no matching sessions.
  }
}

export async function createGitRepo(): Promise<{ repoDir: string; originDir: string }> {
  const rawRepoDir = await createTempDir("spur-runtime-repo-");
  const repoDir = await realpath(rawRepoDir);
  const rawOriginDir = await createTempDir("spur-runtime-origin-");
  const originDir = await realpath(rawOriginDir);
  await execFileAsync("git", ["init", "--bare"], { cwd: originDir });
  await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: originDir });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Spur Test"], { cwd: repoDir });
  await execFileAsync("git", ["remote", "add", "origin", originDir], { cwd: repoDir });
  await execFileAsync("git", ["remote", "add", "upstream", "https://github.com/acme/api.git"], {
    cwd: repoDir,
  });
  await writeFile(join(repoDir, "README.md"), "# Spur Runtime Test\n", "utf8");
  await writeFile(join(repoDir, ".env"), "TEST_ENV=1\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoDir });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });
  return { repoDir, originDir };
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

export async function createRuntimeTestContext(
  port: number,
  options?: { useFakeTools?: boolean; hupResistantAgents?: boolean },
): Promise<RuntimeTestContext> {
  _resetGhPathCacheForTests();
  const rootDir = await createTempDir("spur-runtime-");
  const { repoDir, originDir } = await createGitRepo();
  const dataDir = join(rootDir, "data");
  const worktreeDir = join(rootDir, "worktrees");
  const fakeBinDir = join(rootDir, "bin");
  const agentLogDir = join(rootDir, "agent-logs");
  const ghStateFile = join(rootDir, "gh-state.json");
  const tmuxSocketName = `spur-${port}`;
  const useFakeTools = options?.useFakeTools ?? true;
  const hupResistant = options?.hupResistantAgents ?? false;
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(agentLogDir, { recursive: true });
  await writeFile(join(rootDir, ".zshrc"), "# runtime test shell init\n", "utf8");
  if (useFakeTools) {
    const agentScriptOptions = { hupResistant };
    await writeExecutable(
      join(fakeBinDir, "claude"),
      fakeAgentScript("claude", agentScriptOptions),
    );
    await writeExecutable(join(fakeBinDir, "codex"), fakeAgentScript("codex", agentScriptOptions));
    await writeExecutable(join(fakeBinDir, "agent"), fakeAgentScript("cursor", agentScriptOptions));
    await writeExecutable(
      join(fakeBinDir, "cursor-agent"),
      fakeAgentScript("cursor", agentScriptOptions),
    );
    await writeExecutable(join(fakeBinDir, "gh"), FAKE_GH_SCRIPT);
    await writeFile(ghStateFile, "{}\n", "utf8");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SPUR_IDLE_WAIT_BEFORE_FLUSH_MS: "0",
    ...(useFakeTools
      ? {
          HOME: rootDir,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          SPUR_TMUX_SOCKET_NAME: tmuxSocketName,
          SPUR_CLAUDE_BIN: join(fakeBinDir, "claude"),
          SPUR_CODEX_BIN: join(fakeBinDir, "codex"),
          SPUR_CURSOR_BIN: join(fakeBinDir, "agent"),
          SPUR_SKIP_CODEX_SUBMIT_ACK: "1",
          SPUR_FAKE_AGENT_LOG_DIR: agentLogDir,
          SPUR_FAKE_GH_STATE_FILE: ghStateFile,
        }
      : {}),
  };

  // Arm the isolated tmux socket eagerly so every tmux helper targets `-L
  // spur-<port>` and never the host's default server. Only the fake-tools path
  // drives tmux, matching the SPUR_TMUX_SOCKET_NAME env above.
  if (useFakeTools) {
    setActiveTmuxSocketName(tmuxSocketName);
  }

  const writeConfig = async (name: string, content: string): Promise<string> => {
    const configPath = join(rootDir, name);
    await writeFile(
      configPath,
      `admission:
  enabled: false
  memoryGuard:
    enforceFloors: false
${content}`,
      "utf8",
    );
    return configPath;
  };

  const execCli = async (
    args: string[],
    options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string }> => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      cwd: V2_DIR,
      env: {
        ...env,
        ...(options?.env ?? {}),
      },
      timeout: options?.timeoutMs ?? 60_000,
    });
    return { stdout, stderr };
  };

  const fetchJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `Request failed with status ${response.status}`);
    }
    return JSON.parse(text) as T;
  };

  const startDaemon = async (configPath: string) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, "--config", configPath, "daemon", "start", "--json"],
      {
        cwd: V2_DIR,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    const info = await pollUntil(
      async () => {
        try {
          return await fetchJson<RuntimeInfo>("/info");
        } catch {
          return null;
        }
      },
      {
        timeoutMs: 20_000,
        accept: (value): value is RuntimeInfo => value !== null,
        label: "daemon info",
      },
    );
    // pollUntil throws before returning null, so info is guaranteed non-null here.
    return { child, stdout, info: info as RuntimeInfo };
  };

  const stopDaemon = async (
    child: ChildProcessByStdio<null, Readable, Readable>,
  ): Promise<void> => {
    if (child.exitCode !== null || child.killed) return;
    await stopDaemonByPid(child.pid);
  };

  const readAgentLog = async (sessionId: string): Promise<string> => {
    const path = join(agentLogDir, `${sessionId}.log`);
    return existsSync(path) ? readFile(path, "utf8") : "";
  };

  const writeGhState = async (state: FakeGhState): Promise<void> => {
    await writeFile(ghStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  };

  const cleanup = async (): Promise<void> => {
    _resetGhPathCacheForTests();
    if (useFakeTools) {
      // Tear down the isolated tmux server and re-arm the guard so the next
      // context in this file must activate its own socket.
      killTmuxServer(tmuxSocketName);
      setActiveTmuxSocketName(null);
    }
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(originDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  return {
    rootDir,
    repoDir,
    originDir,
    dataDir,
    worktreeDir,
    fakeBinDir,
    agentLogDir,
    ghStateFile,
    port,
    tmuxSocketName,
    env,
    writeConfig,
    execCli,
    startDaemon,
    stopDaemon,
    fetchJson,
    readAgentLog,
    writeGhState,
    cleanup,
  };
}

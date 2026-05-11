import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeInfo } from "../../src/types.js";
import { createTempDir, execFileAsync, pollUntil } from "./common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const V2_DIR = resolve(__dirname, "../..");
export const CLI_PATH = join(V2_DIR, "dist/cli.js");
const TMUX_BOOTSTRAP_SESSION = `spur-runtime-bootstrap-${process.pid}`;
let tmuxBootstrapReady = false;
let tmuxBootstrapCleanupRegistered = false;
let activeTmuxSocketName: string | null = null;

function setActiveTmuxSocketName(socketName: string | undefined): void {
  const next = socketName?.trim() || null;
  if (activeTmuxSocketName !== next) {
    tmuxBootstrapReady = false;
  }
  activeTmuxSocketName = next;
}

function withTmuxSocket(args: string[]): string[] {
  return activeTmuxSocketName ? ["-L", activeTmuxSocketName, ...args] : args;
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

function fakeAgentScript(agentName: "claude" | "codex" | "cursor"): string {
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
  if [[ -n "$branch_hint" ]]; then
    printf '%s\n' "$branch_hint"
  else
    printf 'NO_PROJECT_RULES\n'
  fi
  exit 0
fi
mode="launch"
resume_id=""
if [[ "\${1:-}" == "--resume" ]]; then
  mode="resume"
  resume_id="\${2:-}"
else
  encoded_path=$(printf '%s' "$PWD" | tr '\\\\' '/' | sed 's/://g; s/[/.]/-/g')
  session_dir="$HOME/.claude/projects/$encoded_path"
  session_uuid="fake-claude-\${SPUR_SESSION:-no-session}"
  mkdir -p "$session_dir"
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
mode="launch"
resume_id=""
if [[ "\${1:-}" == "resume" ]]; then
  mode="resume"
  resume_id="\${@: -1}"
  mkdir -p "$session_dir"
  if [[ ! -f "$session_rollout" ]]; then
    printf '{"type":"session_meta","cwd":"%s","model":"test-model"}\n' "$PWD" > "$session_rollout"
    printf '{"threadId":"%s"}\n' "\${resume_id:-thread-\${SPUR_SESSION:-no-session}}" >> "$session_rollout"
  fi
else
  thread_id="thread-\${SPUR_SESSION:-no-session}"
  mkdir -p "$session_dir"
  printf '{"type":"session_meta","cwd":"%s","model":"test-model"}\n' "$PWD" > "$session_rollout"
  printf '{"threadId":"%s"}\n' "$thread_id" >> "$session_rollout"
fi`
        : `if [[ "\${1:-}" == "-p" || "\${1:-}" == "--print" ]]; then
  branch_hint="$(printf '%s' "$*" | sed -n 's/.*branch hint: \\([^[:space:]]*\\).*/\\1/p' | head -n 1)"
  if [[ -n "$branch_hint" ]]; then
    printf '%s\n' "$branch_hint"
  else
    printf 'NO_PROJECT_RULES\n'
  fi
  exit 0
fi
cursor_base="\${CURSOR_CONFIG_DIR:-$HOME/.cursor}"
workspace_hash="$(node -e 'const { createHash } = require("node:crypto"); const { resolve } = require("node:path"); process.stdout.write(createHash("md5").update(resolve(process.argv[1])).digest("hex"));' "$PWD")"
touch_chat_store() {
  local chat_id="$1"
  local chat_dir="$cursor_base/chats/$workspace_hash/$chat_id"
  mkdir -p "$chat_dir"
  printf 'cursor-session\n' > "$chat_dir/store.db"
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
touch_chat_store "$chat_id"`;
  // State signal helpers — Claude writes JSONL records, Codex writes hook state
  // plus structured rollout events for question/waiting metadata.
  const signalWaiting =
    agentName === "claude"
      ? `jsonl_append '{"type":"assistant","message":{"role":"assistant","content":[],"stop_reason":"end_turn"}}'`
      : agentName === "codex"
        ? `emit_hook_event "Stop"`
        : ":";
  const signalNeedsInput =
    agentName === "claude"
      ? `jsonl_append '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"header":"Plan","question":"Which tier should I run next?","options":[{"label":"fast","description":"Run fast tests first"},{"label":"runtime","description":"Run runtime integration next"}]}]}}]}}'`
      : agentName === "codex"
        ? `emit_hook_needs_input
      emit_rollout_input_required`
        : ":";
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
  // Claude signals working per-line; codex buffers pasted multi-line input and
  // writes a single rollout event_msg with the full message (matching real codex).
  const signalWorking =
    agentName === "claude"
      ? `jsonl_append '{"type":"user","message":{"role":"user","content":[]}}'`
      : "";
  // Codex uses a buffering read loop that drains pasted lines before emitting
  // one event_msg entry, so scanCodexRolloutForMessage sees the full message.
  const codexEmitBuffered = `if [[ -n "\${SPUR_SESSION:-}" && -n "\${session_rollout:-}" ]]; then
    printf '{"type":"event_msg","payload":{"type":"user_message","message":%s}}\\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$full_msg")" >> "$session_rollout"
  fi
  emit_hook_event "UserPromptSubmit"`;
  const readLoop =
    agentName === "claude"
      ? `while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$log_file"
  ${signalWorking}
  case "$line" in
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
        ? `while IFS= read -r line; do
  full_msg="$line"
  printf '%s\\n' "$line" >> "$log_file"
  # Drain remaining lines from the same paste (arrive within 0.1s).
  while IFS= read -r -t 0.1 extra; do
    full_msg="$full_msg
$extra"
    printf '%s\\n' "$extra" >> "$log_file"
  done
  ${codexEmitBuffered}
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
        : `while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$log_file"
  touch_chat_store "$chat_id"
  case "$line" in
    show-waiting-menu)
      printf '%s\\n' "Workspace Trust Required"
      printf '%s\\n' "Do you trust the contents of this directory?"
      ;;
    simulate-work)
      printf '%s\\n' "• Working (simulated)"
      sleep 1
      printf '%s\\n' "${prompt}"
      ;;
    exit-now)
      exit 0
      ;;
    *)
      printf '%s\\n' "ack: $line"
      printf '%s\\n' "${prompt}"
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
printf '%s\n' "startup:$mode:$resume_id:$*" >> "$log_file"
printf '%s\n' "${header}"
printf '%s\n' "${prompt}"
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

if (args[0] === "api" && args[1] === "graphql") {
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

  if (!tmuxBootstrapCleanupRegistered) {
    tmuxBootstrapCleanupRegistered = true;
    process.once("exit", () => {
      spawnSync("tmux", ["kill-session", "-t", TMUX_BOOTSTRAP_SESSION], {
        stdio: "ignore",
      });
    });
  }

  try {
    await execFileAsync("tmux", withTmuxSocket(["has-session", "-t", TMUX_BOOTSTRAP_SESSION]));
    tmuxBootstrapReady = true;
    return;
  } catch {
    // Fall through and create a bootstrap session when no server is live yet.
  }

  try {
    await execFileAsync(
      "tmux",
      withTmuxSocket([
        "new-session",
        "-d",
        "-s",
        TMUX_BOOTSTRAP_SESSION,
        "-x",
        "1",
        "-y",
        "1",
        "sleep 3600",
      ]),
    );
    tmuxBootstrapReady = true;
  } catch {
    // Best effort only.
  }
}

export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync("tmux", withTmuxSocket(["-V"]));
    return true;
  } catch {
    return false;
  }
}

export async function syncTmuxEnvironment(env: Record<string, string | undefined>): Promise<void> {
  setActiveTmuxSocketName(env["SPUR_TMUX_SOCKET_NAME"]);
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
    const { stdout } = await execFileAsync(
      "tmux",
      withTmuxSocket(["capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`]),
    );
    return stdout;
  } catch {
    return "";
  }
}

export async function readTmuxOption(sessionName: string, option: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    withTmuxSocket(["show-options", "-t", sessionName, option]),
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

export async function killTmuxSession(sessionName: string): Promise<void> {
  try {
    await execFileAsync("tmux", withTmuxSocket(["kill-session", "-t", sessionName]));
  } catch {
    // Already gone.
  }
}

export async function killTmuxSessionsByPrefix(prefix: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      withTmuxSocket(["list-sessions", "-F", "#{session_name}"]),
    );
    const sessions = stdout
      .trim()
      .split("\n")
      .map((session) => session.trim())
      .filter((session) => session.startsWith(prefix));
    for (const session of sessions) {
      await killTmuxSession(session);
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
  options?: { useFakeTools?: boolean },
): Promise<RuntimeTestContext> {
  const rootDir = await createTempDir("spur-runtime-");
  const { repoDir, originDir } = await createGitRepo();
  const dataDir = join(rootDir, "data");
  const worktreeDir = join(rootDir, "worktrees");
  const fakeBinDir = join(rootDir, "bin");
  const agentLogDir = join(rootDir, "agent-logs");
  const ghStateFile = join(rootDir, "gh-state.json");
  const useFakeTools = options?.useFakeTools ?? true;
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(agentLogDir, { recursive: true });
  await writeFile(join(rootDir, ".zshrc"), "# runtime test shell init\n", "utf8");
  if (useFakeTools) {
    await writeExecutable(join(fakeBinDir, "claude"), fakeAgentScript("claude"));
    await writeExecutable(join(fakeBinDir, "codex"), fakeAgentScript("codex"));
    await writeExecutable(join(fakeBinDir, "agent"), fakeAgentScript("cursor"));
    await writeExecutable(join(fakeBinDir, "cursor-agent"), fakeAgentScript("cursor"));
    await writeExecutable(join(fakeBinDir, "gh"), FAKE_GH_SCRIPT);
    await writeFile(ghStateFile, "{}\n", "utf8");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(useFakeTools
      ? {
          HOME: rootDir,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          SPUR_TMUX_SOCKET_NAME: `spur-${port}`,
          SPUR_CLAUDE_BIN: join(fakeBinDir, "claude"),
          SPUR_CODEX_BIN: join(fakeBinDir, "codex"),
          SPUR_CURSOR_BIN: join(fakeBinDir, "agent"),
          SPUR_SKIP_CODEX_SUBMIT_ACK: "1",
          SPUR_FAKE_AGENT_LOG_DIR: agentLogDir,
          SPUR_FAKE_GH_STATE_FILE: ghStateFile,
        }
      : {}),
  };

  const writeConfig = async (name: string, content: string): Promise<string> => {
    const configPath = join(rootDir, name);
    await writeFile(configPath, content, "utf8");
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
    setActiveTmuxSocketName(env["SPUR_TMUX_SOCKET_NAME"]);
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
      },
    );
    if (!info) {
      throw new Error("Timed out waiting for daemon info");
    }

    return { child, stdout, info };
  };

  const stopDaemon = async (
    child: ChildProcessByStdio<null, Readable, Readable>,
  ): Promise<void> => {
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);
      }),
    ]);
  };

  const readAgentLog = async (sessionId: string): Promise<string> => {
    const path = join(agentLogDir, `${sessionId}.log`);
    return existsSync(path) ? readFile(path, "utf8") : "";
  };

  const writeGhState = async (state: FakeGhState): Promise<void> => {
    await writeFile(ghStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  };

  const cleanup = async (): Promise<void> => {
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

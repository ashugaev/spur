import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeInfo } from "../../src/types.js";
import { createTempDir, execFileAsync, pollUntil } from "./common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const V2_DIR = resolve(__dirname, "../..");
export const CLI_PATH = join(V2_DIR, "dist/cli.js");

export interface FakeGhState {
  prsByBranch?: Record<
    string,
    {
      number: number;
      title: string;
      url: string;
      reviewDecision?: string | null;
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
}

export interface RuntimeTestContext {
  rootDir: string;
  repoDir: string;
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
    child: ChildProcessWithoutNullStreams;
    stdout: string;
    info: RuntimeInfo;
  }>;
  stopDaemon(child: ChildProcessWithoutNullStreams): Promise<void>;
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
  readAgentLog(sessionId: string): Promise<string>;
  writeGhState(state: FakeGhState): Promise<void>;
  cleanup(): Promise<void>;
}

function fakeAgentScript(agentName: "claude" | "codex"): string {
  const header = agentName === "claude" ? "Claude Code" : "OpenAI Codex";
  const prompt = agentName === "claude" ? "❯" : "›";
  const startup =
    agentName === "claude"
      ? `mode="launch"
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
fi`
      : `mode="launch"
resume_id=""
if [[ "\${1:-}" == "resume" ]]; then
  mode="resume"
  resume_id="\${@: -1}"
else
  session_dir="$HOME/.codex/sessions/2026/03/18"
  thread_id="thread-\${SPUR_SESSION:-no-session}"
  mkdir -p "$session_dir"
  printf '{"type":"session_meta","cwd":"%s","model":"test-model"}\n' "$PWD" > "$session_dir/rollout-\${SPUR_SESSION:-no-session}.jsonl"
  printf '{"threadId":"%s"}\n' "$thread_id" >> "$session_dir/rollout-\${SPUR_SESSION:-no-session}.jsonl"
fi`;
  return `#!/usr/bin/env bash
set -euo pipefail
log_dir="\${SPUR_FAKE_AGENT_LOG_DIR:?missing SPUR_FAKE_AGENT_LOG_DIR}"
mkdir -p "$log_dir"
log_file="$log_dir/\${SPUR_SESSION:-no-session}.log"
${startup}
printf '%s\n' "startup:$mode:$resume_id:$*" >> "$log_file"
if [[ "$mode" == "launch" ]]; then
  printf '%s\n' "${header}"
fi
printf '%s\n' "${prompt}"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log_file"
  case "$line" in
    show-waiting-menu)
      printf '%s\n' "Entered plan mode"
      printf '%s\n' "1. fast"
      printf '%s\n' "2. runtime"
      printf '%s\n' "Enter to select"
      printf '%s\n' "Esc to cancel"
      ;;
    simulate-work)
      printf '%s\n' "• Working (simulated)"
      sleep 1
      printf '%s\n' "${prompt}"
      ;;
    exit-now)
      exit 0
      ;;
    *)
      printf '%s\n' "ack: $line"
      printf '%s\n' "${prompt}"
      ;;
  esac
done
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
  try {
    await execFileAsync("tmux", ["start-server"]);
  } catch {
    // Best effort only.
  }
}

export async function isTmuxAvailable(): Promise<boolean> {
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
    await execFileAsync("tmux", ["set-environment", "-g", key, value]);
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
  await execFileAsync("tmux", tmuxArgs, { cwd: args.cwd });
}

export async function captureTmuxPane(sessionName: string, lines = 80): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "capture-pane",
      "-t",
      sessionName,
      "-p",
      "-S",
      `-${lines}`,
    ]);
    return stdout;
  } catch {
    return "";
  }
}

export async function sendKeysToTmux(sessionName: string, ...keys: string[]): Promise<void> {
  await execFileAsync("tmux", ["send-keys", "-t", sessionName, ...keys]);
}

export async function killTmuxSession(sessionName: string): Promise<void> {
  try {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]);
  } catch {
    // Already gone.
  }
}

export async function killTmuxSessionsByPrefix(prefix: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"]);
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

export async function createGitRepo(): Promise<string> {
  const rawRepoDir = await createTempDir("spur-runtime-repo-");
  const repoDir = await realpath(rawRepoDir);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Spur Test"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "# Spur Runtime Test\n", "utf8");
  await writeFile(join(repoDir, ".env"), "TEST_ENV=1\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoDir });
  return repoDir;
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
  const repoDir = await createGitRepo();
  const dataDir = join(rootDir, "data");
  const worktreeDir = join(rootDir, "worktrees");
  const fakeBinDir = join(rootDir, "bin");
  const agentLogDir = join(rootDir, "agent-logs");
  const ghStateFile = join(rootDir, "gh-state.json");
  const useFakeTools = options?.useFakeTools ?? true;
  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(agentLogDir, { recursive: true });
  if (useFakeTools) {
    await writeExecutable(join(fakeBinDir, "claude"), fakeAgentScript("claude"));
    await writeExecutable(join(fakeBinDir, "codex"), fakeAgentScript("codex"));
    await writeExecutable(join(fakeBinDir, "gh"), FAKE_GH_SCRIPT);
    await writeFile(ghStateFile, "{}\n", "utf8");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(useFakeTools
      ? {
          HOME: rootDir,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          SPUR_CLAUDE_BIN: join(fakeBinDir, "claude"),
          SPUR_CODEX_BIN: join(fakeBinDir, "codex"),
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
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, ...args],
      {
        cwd: V2_DIR,
        env: {
          ...env,
          ...(options?.env ?? {}),
        },
        timeout: options?.timeoutMs ?? 60_000,
      },
    );
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
      },
    );

    return { child, stdout, info };
  };

  const stopDaemon = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
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
    await rm(rootDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  };

  return {
    rootDir,
    repoDir,
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

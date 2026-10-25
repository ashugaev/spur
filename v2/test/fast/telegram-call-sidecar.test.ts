import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadProjectConfig } from "../../src/config.js";
import { buildIsolatedProjectConfig } from "../../src/isolated-project-config.js";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), "spur-test-voice-sidecar-"));
  paths.push(path);
  return path;
}

function inputChecker(path: string, status = 0): string {
  const python = join(path, "input-checker");
  writeFileSync(python, `#!/bin/bash\n[[ "$2" == --check-inputs ]] || exit 91\nexit ${status}\n`);
  chmodSync(python, 0o700);
  return python;
}

it.each(["run-daemon.sh", "run-call.sh"])(
  "%s rejects unconfigured inputs before creating runtime or private state",
  (launcher) => {
    const path = fixture();
    const state = join(path, "state");
    const tools = join(path, "tools");
    const result = spawnSync("/bin/bash", [resolve(`../scripts/telegram-call/${launcher}`)], {
      env: {
        ...process.env,
        TELEGRAM_CALL_PYTHON: inputChecker(path, 1),
        TELEGRAM_CALL_STATE_DIR: state,
        TELEGRAM_CALL_ENV_FILE: join(path, "missing.env"),
        SPUR_SESSION_TOOL_DIR: tools,
      },
    });
    expect(result.status).toBe(1);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(tools)).toBe(false);
  },
);

it("composes two manual private sidecars without a public endpoint", () => {
  const path = fixture();
  execFileSync("git", ["init", "-q"], { cwd: path });
  const configPath = join(path, "project.yaml");
  writeFileSync(
    configPath,
    buildIsolatedProjectConfig(readFileSync(resolve("../spur.yaml"), "utf8"), path),
  );
  const sidecars = loadProjectConfig(configPath).projects["sp"]?.sidecars;
  expect(sidecars?.["voice-call"]?.dependsOn).toEqual(["voice-daemon"]);
  expect(sidecars?.["voice-call"]?.autoStart).toBe(false);
  expect(sidecars?.["voice-daemon"]?.autoStart).toBe(false);
  expect(sidecars?.["voice-daemon"]?.ports?.["daemon"]?.url).toBeUndefined();
});

it("launches an unknown-selection fixture containing only a disposable project", () => {
  const path = fixture();
  const bin = join(path, "bin");
  const tools = join(path, "tools");
  mkdirSync(bin);
  mkdirSync(tools);
  const output = join(path, "output.yaml");
  const capture = join(path, "capture");
  // Replace only child bash; execute the real config writer with its actual inputs.
  const fake = join(bin, "bash");
  writeFileSync(
    fake,
    `#!/bin/bash\nset -euo pipefail\n[[ "$SPUR_PROJECT" == voice-controller ]]\n[[ "$SPUR_ISOLATED_WITHOUT_TELEGRAM" == 1 ]]\nprintf '%s\\n%s\\n' "$SPUR_SESSION_TOOL_DIR" "$SPUR_PROJECT_CONFIG_PATH" > "$VOICE_CAPTURE"\nexec "$VOICE_NODE" "$VOICE_WRITER" --input "$SPUR_PROJECT_CONFIG_PATH" --output "$VOICE_OUTPUT" --worktree "$VOICE_REPO" --project "$SPUR_PROJECT" --without-telegram\n`,
  );
  chmodSync(fake, 0o700);
  execFileSync("/bin/bash", [resolve("../scripts/telegram-call/run-daemon.sh")], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      SPUR_SESSION_TOOL_DIR: tools,
      TELEGRAM_CALL_PYTHON: inputChecker(path),
      TELEGRAM_CALL_STATE_DIR: join(path, "state"),
      VOICE_CAPTURE: capture,
      VOICE_NODE: process.execPath,
      VOICE_WRITER: resolve("bin/write-isolated-project-config.mjs"),
      VOICE_OUTPUT: output,
      VOICE_REPO: resolve(".."),
    },
  });
  const [scopedTools, input] = readFileSync(capture, "utf8").trim().split("\n");
  expect(scopedTools).toBe(join(tools, "voice-daemon"));
  expect(statSync(join(tools, "voice-daemon")).mode & 0o777).toBe(0o700);
  const config = loadProjectConfig(output);
  expect(Object.keys(config.projects)).toEqual(["voice-sandbox"]);
  const sandbox = config.projects["voice-sandbox"];
  expect(sandbox?.path).not.toBe(resolve(".."));
  expect(sandbox?.sources).toEqual({});
  expect(sandbox?.triggers).toEqual({});
  expect(sandbox?.sidecars).toEqual({});
  expect(sandbox?.symlinks).toEqual([]);
  if (input === undefined) throw new Error("Missing sandbox fixture path");
  expect(existsSync(dirname(input))).toBe(false);
});

it("forwards dependency probes to private Python without requiring a runtime", () => {
  const path = fixture();
  const python = join(path, "python");
  writeFileSync(python, '#!/bin/bash\nprintf "%s\\n" "$@"\n');
  chmodSync(python, 0o700);
  const state = join(path, "state");
  const output = execFileSync(
    "bash",
    [resolve("../scripts/telegram-call/run-call.sh"), "--check-deps"],
    {
      env: { ...process.env, TELEGRAM_CALL_PYTHON: python, TELEGRAM_CALL_STATE_DIR: state },
      encoding: "utf8",
    },
  );
  expect(output).toContain("bridge.py\n--check-deps");
  expect(statSync(state).mode & 0o777).toBe(0o700);
});

it.each([false, true])("checks inputs before listener launch (override=%s)", (override) => {
  const path = fixture();
  const state = join(path, "state");
  mkdirSync(state);
  writeFileSync(join(state, "call.env"), "");
  const selected = override ? join(path, "override.env") : join(state, "call.env");
  const python = join(path, "python");
  writeFileSync(
    python,
    '#!/bin/bash\nif [[ "$#" == 1 ]]; then set -- "$1" listener; fi\nprintf "%s|%s\\n" "$2" "$TELEGRAM_CALL_ENV_FILE"\n',
  );
  chmodSync(python, 0o700);
  const output = execFileSync("/bin/bash", [resolve("../scripts/telegram-call/run-call.sh")], {
    env: {
      ...process.env,
      TELEGRAM_CALL_PYTHON: python,
      TELEGRAM_CALL_STATE_DIR: state,
      TELEGRAM_CALL_ENV_FILE: override ? selected : "",
      SPUR_SESSION_TOOL_DIR: join(path, "tools"),
    },
    encoding: "utf8",
  });
  expect(output.trim().split("\n")).toEqual([`--check-inputs|${selected}`, `listener|${selected}`]);
});

it("finishes owned tmux teardown when pane HUP follows TERM", async () => {
  const path = fixture();
  const bin = join(path, "bin");
  const tools = join(path, "tools");
  const capture = join(path, "capture");
  const marker = join(path, "cleaning");
  const termed = join(path, "termed");
  const launcher = join(path, "spur-isolated-daemon.TEST");
  const socket = `spur-voice-test-${process.pid}`;
  mkdirSync(bin);
  mkdirSync(tools);
  const tmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "bash"),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$SPUR_PROJECT_CONFIG_PATH" > "$VOICE_CAPTURE"
"$VOICE_TMUX" -L "$VOICE_SOCKET" -f /dev/null new-session -d -s owned 'sleep 60'
mkdir -p "$VOICE_LAUNCHER"
cat > "$SPUR_SESSION_TOOL_DIR/isolated-env.sh" <<RUNTIME
SPUR_ISOLATED_CONFIG="$VOICE_LAUNCHER/config.yaml"
SPUR_ISOLATED_DAEMON_PID="$$"
SPUR_ISOLATED_TMUX_SOCKET_NAME="$VOICE_SOCKET"
RUNTIME
printf 'READY\\n'
exec "$VOICE_NODE" -e 'process.on("SIGTERM",()=>{require("node:fs").writeFileSync(process.env.VOICE_TERMED,"1");process.exit(0)});process.stdin.resume();setInterval(()=>{},1000)'
`,
  );
  writeFileSync(
    join(bin, "tmux"),
    `#!/bin/bash
if [[ "$*" == *list-panes* ]]; then
  touch "$VOICE_MARKER"
  sleep 0.1
fi
exec "$VOICE_TMUX" "$@"
`,
  );
  chmodSync(join(bin, "bash"), 0o700);
  chmodSync(join(bin, "tmux"), 0o700);
  const child = spawn("/bin/bash", [resolve("../scripts/telegram-call/run-daemon.sh")], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      SPUR_SESSION_TOOL_DIR: tools,
      TELEGRAM_CALL_PYTHON: inputChecker(path),
      TELEGRAM_CALL_STATE_DIR: join(path, "state"),
      VOICE_CAPTURE: capture,
      VOICE_MARKER: marker,
      VOICE_TERMED: termed,
      VOICE_NODE: process.execPath,
      VOICE_TMUX: tmux,
      VOICE_SOCKET: socket,
      VOICE_LAUNCHER: launcher,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    await new Promise<void>((ready, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("READY")) ready();
      });
      child.on("error", reject);
    });
    const input = readFileSync(capture, "utf8").trim();
    child.kill("SIGTERM");
    for (let index = 0; index < 100 && !existsSync(marker); index += 1)
      await new Promise((done) => setTimeout(done, 5));
    expect(existsSync(marker)).toBe(true);
    child.kill("SIGHUP");
    const [code] = await exited;
    expect(code).toBe(143);
    // Daemon stopped on TERM, not on the KILL escalation; teardown ran to completion.
    expect(existsSync(termed)).toBe(true);
    expect(stderr).not.toContain("sandbox retained");
    expect(() => execFileSync(tmux, ["-L", socket, "has-session"], { stdio: "pipe" })).toThrow();
    expect(existsSync(join(tools, "voice-daemon/isolated-env.sh"))).toBe(false);
    expect(existsSync(dirname(input))).toBe(false);
    expect(existsSync(launcher)).toBe(false);
  } finally {
    child.kill("SIGKILL");
    try {
      execFileSync(tmux, ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // The tested cleanup already stopped this test's socket.
    }
  }
});

function receiptStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] ?? "";
}

function runWithReceipt(
  receipt: (path: string) => string,
  prepare?: (path: string, voiceDir: string) => void,
): {
  status: number | null;
  stderr: string;
  started: boolean;
  receiptPath: string;
} {
  const path = fixture();
  const bin = join(path, "bin");
  const tools = join(path, "tools");
  const started = join(path, "started");
  mkdirSync(bin);
  mkdirSync(join(tools, "voice-daemon"), { recursive: true });
  writeFileSync(join(bin, "bash"), `#!/bin/bash\ntouch "$VOICE_STARTED"\n`);
  chmodSync(join(bin, "bash"), 0o700);
  const receiptPath = join(tools, "voice-daemon/isolated-env.sh");
  writeFileSync(receiptPath, receipt(path));
  prepare?.(path, join(tools, "voice-daemon"));
  const result = spawnSync("/bin/bash", [resolve("../scripts/telegram-call/run-daemon.sh")], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      SPUR_SESSION_TOOL_DIR: tools,
      TELEGRAM_CALL_PYTHON: inputChecker(path),
      TELEGRAM_CALL_STATE_DIR: join(path, "state"),
      VOICE_STARTED: started,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stderr: result.stderr,
    started: existsSync(started),
    receiptPath,
  };
}

it("restarts when the receipt names a dead daemon", () => {
  const dead = spawnSync("/bin/true");
  expect(dead.pid).toBeGreaterThan(0);
  const result = runWithReceipt(
    () => `SPUR_ISOLATED_DAEMON_PID="${dead.pid}"\nSPUR_ISOLATED_DAEMON_STARTTIME="1"\n`,
  );
  expect(result.status).toBe(0);
  expect(result.started).toBe(true);
  expect(existsSync(result.receiptPath)).toBe(false);
});

it("restarts when the receipt names a reused pid with another start time", () => {
  const live = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const result = runWithReceipt(
      () => `SPUR_ISOLATED_DAEMON_PID="${live.pid}"\nSPUR_ISOLATED_DAEMON_STARTTIME="1"\n`,
    );
    expect(result.status).toBe(0);
    expect(result.started).toBe(true);
    expect(live.exitCode).toBeNull();
  } finally {
    live.kill("SIGKILL");
  }
});

it("still refuses while the receipt daemon is alive", () => {
  const live = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const result = runWithReceipt(
      () =>
        `SPUR_ISOLATED_DAEMON_PID="${live.pid}"\nSPUR_ISOLATED_DAEMON_STARTTIME="${receiptStart(live.pid ?? 0)}"\n`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scoped runtime already exists");
    expect(result.started).toBe(false);
    expect(existsSync(result.receiptPath)).toBe(true);
  } finally {
    live.kill("SIGKILL");
  }
});

function deadPid(): number {
  const dead = spawnSync("/bin/true");
  expect(dead.pid).toBeGreaterThan(0);
  return dead.pid;
}

const staleSockets: string[] = [];
afterEach(() => {
  for (const socket of staleSockets.splice(0)) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // Server already gone.
    }
  }
});

it("refuses when the daemon is dead but its tmux server still runs", () => {
  const socket = `spur-voice-stale-${process.pid}`;
  staleSockets.push(socket);
  execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "sleep 60"]);
  const pid = deadPid();
  const result = runWithReceipt(
    () =>
      `SPUR_ISOLATED_DAEMON_PID="${pid}"\nSPUR_ISOLATED_DAEMON_STARTTIME="1"\nSPUR_ISOLATED_TMUX_SOCKET_NAME="${socket}"\n`,
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(socket);
  expect(result.started).toBe(false);
  expect(existsSync(result.receiptPath)).toBe(true);
  expect(() => execFileSync("tmux", ["-L", socket, "has-session"], { stdio: "pipe" })).not.toThrow();
});

function staleDirs(path: string): { fixtureDir: string; launcher: string } {
  const fixtureDir = join(path, "spur-voice-sandbox.OLD");
  const launcher = join(path, "spur-isolated-daemon.OLD");
  mkdirSync(join(fixtureDir, "repository"), { recursive: true });
  writeFileSync(join(fixtureDir, "project.yaml"), "projects: {}\n");
  mkdirSync(launcher);
  writeFileSync(join(launcher, "config.yaml"), "x: 1\n");
  return { fixtureDir, launcher };
}

it("removes stale fixture and launcher dirs when daemon and tmux are gone", () => {
  const pid = deadPid();
  let dirs = { fixtureDir: "", launcher: "" };
  const result = runWithReceipt(
    (path) => {
      dirs = staleDirs(path);
      return `SPUR_ISOLATED_DAEMON_PID="${pid}"\nSPUR_ISOLATED_DAEMON_STARTTIME="1"\nSPUR_ISOLATED_CONFIG="${dirs.launcher}/config.yaml"\nSPUR_ISOLATED_TMUX_SOCKET_NAME="spur-voice-none-${process.pid}"\n`;
    },
    (_path, voiceDir) => writeFileSync(join(voiceDir, "fixture-dir"), `${dirs.fixtureDir}\n`),
  );
  expect(result.status).toBe(0);
  expect(result.started).toBe(true);
  expect(existsSync(dirs.fixtureDir)).toBe(false);
  expect(existsSync(dirs.launcher)).toBe(false);
});

it("leaves dirs outside the owned name patterns untouched", () => {
  const pid = deadPid();
  let outside = "";
  let fixtureLike = "";
  const result = runWithReceipt(
    (path) => {
      outside = join(path, "keep-config");
      fixtureLike = join(path, "keep-fixture");
      mkdirSync(outside);
      writeFileSync(join(outside, "config.yaml"), "x: 1\n");
      mkdirSync(join(fixtureLike, "repository"), { recursive: true });
      writeFileSync(join(fixtureLike, "project.yaml"), "projects: {}\n");
      return `SPUR_ISOLATED_DAEMON_PID="${pid}"\nSPUR_ISOLATED_DAEMON_STARTTIME="1"\nSPUR_ISOLATED_CONFIG="${outside}/config.yaml"\n`;
    },
    (_path, voiceDir) => writeFileSync(join(voiceDir, "fixture-dir"), `${fixtureLike}\n`),
  );
  expect(result.status).toBe(0);
  expect(existsSync(join(outside, "config.yaml"))).toBe(true);
  expect(existsSync(join(fixtureLike, "project.yaml"))).toBe(true);
});

import { execFileSync, spawn } from "node:child_process";
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

it("finishes owned tmux teardown when pane HUP follows TERM", async () => {
  const path = fixture();
  const bin = join(path, "bin");
  const tools = join(path, "tools");
  const capture = join(path, "capture");
  const marker = join(path, "cleaning");
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
cat > "$SPUR_SESSION_TOOL_DIR/isolated-env.sh" <<RUNTIME
SPUR_ISOLATED_DAEMON_PID="$$"
SPUR_ISOLATED_TMUX_SOCKET_NAME="$VOICE_SOCKET"
RUNTIME
printf 'READY\\n'
exec "$VOICE_NODE" -e 'process.stdin.resume();setInterval(()=>{},1000)'
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
      VOICE_CAPTURE: capture,
      VOICE_MARKER: marker,
      VOICE_NODE: process.execPath,
      VOICE_TMUX: tmux,
      VOICE_SOCKET: socket,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    await new Promise<void>((ready, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("READY")) ready();
      });
      child.on("error", reject);
    });
    const input = readFileSync(capture, "utf8").trim();
    const started = Date.now();
    child.kill("SIGTERM");
    for (let index = 0; index < 100 && !existsSync(marker); index += 1)
      await new Promise((done) => setTimeout(done, 5));
    expect(existsSync(marker)).toBe(true);
    child.kill("SIGHUP");
    const [code] = await exited;
    expect(code).toBe(143);
    expect(Date.now() - started).toBeLessThan(1400);
    expect(() => execFileSync(tmux, ["-L", socket, "has-session"], { stdio: "pipe" })).toThrow();
    expect(existsSync(join(tools, "voice-daemon/isolated-env.sh"))).toBe(false);
    expect(existsSync(dirname(input))).toBe(false);
  } finally {
    child.kill("SIGKILL");
    try {
      execFileSync(tmux, ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // The tested cleanup already stopped this test's socket.
    }
  }
});

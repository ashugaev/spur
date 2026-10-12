import { execFileSync } from "node:child_process";
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

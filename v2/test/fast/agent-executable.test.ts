import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentExecutableCommand,
  agentProcessNames,
  missingAgentExecutableMessage,
  resolveAgentExecutable,
} from "../../src/agents/executable.js";
import { checkOpenCodeExecutable } from "../../src/host-install.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("agent executable resolution", () => {
  it("keeps established command and environment contracts for every agent", () => {
    expect(agentExecutableCommand("claude")).toBe(process.env["SPUR_CLAUDE_BIN"] || "claude");
    expect(agentExecutableCommand("codex")).toBe(process.env["SPUR_CODEX_BIN"] || "codex");
    expect(agentExecutableCommand("cursor")).toBe(process.env["SPUR_CURSOR_BIN"] || "agent");
    expect(agentExecutableCommand("opencode")).toBe(process.env["SPUR_OPENCODE_BIN"] || "opencode");
  });

  it("resolves a PATH executable after a fresh environment", async () => {
    const first = await mkdtemp(join(tmpdir(), "spur-agent-bin-first-"));
    const second = await mkdtemp(join(tmpdir(), "spur-agent-bin-second-"));
    cleanupPaths.push(first, second);
    const executable = join(second, "opencode");
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);
    vi.stubEnv("PATH", first);
    expect(resolveAgentExecutable("opencode").path).toBeNull();
    vi.stubEnv("PATH", second);
    expect(resolveAgentExecutable("opencode")).toEqual({
      command: "opencode",
      path: executable,
      source: "path",
    });
  });

  it("uses an explicit executable path without relying on PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spur-agent-bin-override-"));
    cleanupPaths.push(directory);
    const executable = join(directory, "opencode");
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);
    vi.stubEnv("PATH", "");
    vi.stubEnv("SPUR_OPENCODE_BIN", executable);
    expect(resolveAgentExecutable("opencode")).toEqual({
      command: executable,
      path: executable,
      source: "environment",
    });
  });

  it("names the missing command and supported override", () => {
    vi.stubEnv("PATH", "");
    vi.stubEnv("SPUR_OPENCODE_BIN", "/missing/opencode");
    expect(missingAgentExecutableMessage("opencode")).toBe(
      "opencode executable not found: /missing/opencode; install it on PATH or set SPUR_OPENCODE_BIN to an executable path",
    );
  });

  it("names each agent's canonical process names, independent of any SPUR_*_BIN override", () => {
    expect(agentProcessNames("claude")).toEqual(["claude"]);
    expect(agentProcessNames("codex")).toEqual(["codex"]);
    expect(agentProcessNames("cursor")).toEqual(["agent", "cursor-agent"]);
    expect(agentProcessNames("opencode")).toEqual(["opencode"]);

    vi.stubEnv("SPUR_CLAUDE_BIN", "/opt/bin/claude-wrap.sh");
    vi.stubEnv("SPUR_CODEX_BIN", "/opt/bin/codex-wrap.sh");
    vi.stubEnv("SPUR_CURSOR_BIN", "/opt/bin/cursor-wrap.sh");
    vi.stubEnv("SPUR_OPENCODE_BIN", "/opt/bin/oc-wrap.sh");
    expect(agentProcessNames("claude")).toEqual(["claude"]);
    expect(agentProcessNames("codex")).toEqual(["codex"]);
    expect(agentProcessNames("cursor")).toEqual(["agent", "cursor-agent"]);
    expect(agentProcessNames("opencode")).toEqual(["opencode"]);
  });

  it("gives doctor an actionable optional-agent warning", () => {
    vi.stubEnv("PATH", "");
    vi.stubEnv("SPUR_OPENCODE_BIN", "/missing/opencode");
    expect(checkOpenCodeExecutable()).toEqual({
      id: "opencode-executable",
      ok: false,
      severity: "warn",
      detail: "OpenCode executable not found: /missing/opencode",
      fix: "npm install -g --prefix ~/.local opencode-ai, or set SPUR_OPENCODE_BIN to an executable path",
    });
  });
});

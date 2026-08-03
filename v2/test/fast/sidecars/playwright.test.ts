import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  killProcessTree,
  isLeakedManagedPlaywright,
  playwrightMcpUrl,
  PLAYWRIGHT_SIDECAR_CONFIG,
  PLAYWRIGHT_SIDECAR_NAME,
  resolvePlaywrightMcpBin,
  resolvePlaywrightSidecarCommand,
  SPUR_RESERVED_PORT_PLAYWRIGHT,
  type ProcessInfo,
} from "../../../src/sidecars/playwright.js";
import { shellEscape } from "../../../src/agents/shell-escape.js";

describe("playwrightMcpUrl", () => {
  it("uses localhost, not the bare loopback IP, in the client-facing URL", () => {
    // @playwright/mcp's DNS-rebinding protection rejects a "127.0.0.1:<port>"
    // Host header with HTTP 403 while accepting "localhost:<port>".
    expect(playwrightMcpUrl(8793)).toBe("http://localhost:8793/mcp");
    expect(playwrightMcpUrl(8793)).not.toContain("127.0.0.1");
  });
});

describe("PLAYWRIGHT_SIDECAR_CONFIG", () => {
  // `command` is a static placeholder (never touches the filesystem) so
  // importing this module, and loading config for any project, never pays
  // the @playwright/mcp resolution cost or fails when it is missing (MUST-FIX
  // 1). It still carries every non-bin flag so config/tests can assert on it.
  it("carries the launch flags as a static placeholder, without resolving the real bin", () => {
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).not.toContain("npx");
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command.startsWith("exec node ")).toBe(true);
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).toContain("--headless");
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).toContain("--isolated");
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).toContain("--host 127.0.0.1");
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).toContain(`--port $${SPUR_RESERVED_PORT_PLAYWRIGHT}`);
    // The placeholder bin path differs from the real, filesystem-resolved one.
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).not.toBe(resolvePlaywrightSidecarCommand());
  });

  it("does not pass --shared-browser-context", () => {
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).not.toContain("--shared-browser-context");
  });

  it("is off by default (autoStart) — a project must opt in", () => {
    expect(PLAYWRIGHT_SIDECAR_CONFIG.autoStart).toBe(false);
  });

  it("scopes to claude/codex only — cursor never gets it", () => {
    expect(PLAYWRIGHT_SIDECAR_CONFIG.agents).toEqual(["claude", "codex"]);
  });

  it("reserves an http port in 8730-8799 with no published url", () => {
    const port = PLAYWRIGHT_SIDECAR_CONFIG.ports?.["http"];
    expect(port?.env).toBe(SPUR_RESERVED_PORT_PLAYWRIGHT);
    expect(port?.start).toBe(8730);
    expect(port?.end).toBe(8799);
    expect(port?.url).toBeUndefined();
  });

  it("carries the MCP wiring for the http port, client-facing localhost", () => {
    expect(PLAYWRIGHT_SIDECAR_CONFIG.mcp).toEqual({
      server: PLAYWRIGHT_SIDECAR_NAME,
      portId: "http",
      path: "/mcp",
      clientHost: "localhost",
    });
  });
});

describe("resolvePlaywrightSidecarCommand", () => {
  it("resolves the real bin at call time", () => {
    const bin = resolvePlaywrightMcpBin();
    const command = resolvePlaywrightSidecarCommand();
    expect(command.startsWith(`exec node ${shellEscape(bin)} `)).toBe(true);
    expect(command).toContain("--headless");
    expect(command).toContain("--isolated");
    expect(command).toContain("--host 127.0.0.1");
    expect(command).toContain(`--port $${SPUR_RESERVED_PORT_PLAYWRIGHT}`);
  });

  // The pane runs `sh -lc '<command>'` with no exec of its own, so without a
  // leading `exec` the pane pid is a shell that survives above node. That
  // shell carries the UNEXPANDED "--port $SPUR_RESERVED_PORT_PLAYWRIGHT" (no
  // digits, so extractPlaywrightPort returns undefined) and node's ppid is
  // that shell rather than 1 — isLeakedManagedPlaywright matches neither and
  // the tree leaks forever. `exec` collapses the pane to node itself.
  it("execs so the sweep can match the pane process itself", () => {
    // Load-bearing: the pane pid must be node, not a shell above it.
    expect(resolvePlaywrightSidecarCommand().startsWith("exec node ")).toBe(true);
    const bin = resolvePlaywrightMcpBin();
    // The shape the sweep would face without exec: the shell holds the
    // unexpanded port (no digits) and node's ppid is that shell, so neither
    // process is matchable and the whole tree leaks.
    const shell: ProcessInfo = {
      pid: 2000,
      ppid: 1,
      args: `sh -lc node ${bin} --headless --isolated --host 127.0.0.1 --port $${SPUR_RESERVED_PORT_PLAYWRIGHT}`,
    };
    const nodeUnderShell: ProcessInfo = {
      pid: 2001,
      ppid: 2000,
      args: `node ${bin} --headless --isolated --host 127.0.0.1 --port 8751`,
    };
    expect(isLeakedManagedPlaywright(shell, new Set())).toBe(false);
    expect(isLeakedManagedPlaywright(nodeUnderShell, new Set())).toBe(false);
    // With exec the orphan is node itself, reparented to init: matchable.
    expect(isLeakedManagedPlaywright({ ...nodeUnderShell, ppid: 1 }, new Set())).toBe(true);
  });
});

describe("lazy bin resolution (MUST-FIX 1)", () => {
  it("never resolves @playwright/mcp at module import time, only when explicitly called", async () => {
    vi.resetModules();
    vi.doMock("node:module", () => ({
      createRequire: () => {
        throw new Error("createRequire must not run at import time");
      },
    }));
    try {
      const mod = await import("../../../src/sidecars/playwright.js");
      // Import itself must not throw even though createRequire is poisoned.
      expect(mod.PLAYWRIGHT_SIDECAR_CONFIG.command).toContain("--headless");
      // Resolution is only attempted, and fails loudly, when actually invoked.
      expect(() => mod.resolvePlaywrightMcpBin()).toThrow(
        "createRequire must not run at import time",
      );
      expect(() => mod.resolvePlaywrightSidecarCommand()).toThrow(
        "createRequire must not run at import time",
      );
    } finally {
      vi.doUnmock("node:module");
      vi.resetModules();
    }
  });

  it("wraps a missing @playwright/mcp in a clear error", async () => {
    vi.resetModules();
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: () => {
          throw new Error("Cannot find module '@playwright/mcp/package.json'");
        },
      }),
    }));
    try {
      const mod = await import("../../../src/sidecars/playwright.js");
      expect(() => mod.resolvePlaywrightMcpBin()).toThrow(
        "Playwright MCP sidecar unavailable: @playwright/mcp is not installed",
      );
    } finally {
      vi.doUnmock("node:module");
      vi.resetModules();
    }
  });

  // The boot sweep's caller leaves driftedSessions empty when this throws, which
  // silently skips restoreAfterReboot; the 60s reaper tick would also log a
  // failure forever. Nothing we started can be alive if the package is gone.
  it("sweeps nothing instead of throwing when @playwright/mcp is unresolvable", async () => {
    vi.resetModules();
    vi.doMock("node:module", () => ({
      createRequire: () => ({
        resolve: () => {
          throw new Error("Cannot find module '@playwright/mcp/package.json'");
        },
      }),
    }));
    try {
      const mod = await import("../../../src/sidecars/playwright.js");
      await expect(mod.sweepLeakedPlaywright(new Set<number>())).resolves.toBe(0);
    } finally {
      vi.doUnmock("node:module");
      vi.resetModules();
    }
  });
});

describe("isLeakedManagedPlaywright", () => {
  const bin = resolvePlaywrightMcpBin();
  const leaked: ProcessInfo = {
    pid: 1000,
    ppid: 1,
    args: `node ${bin} --headless --isolated --host 127.0.0.1 --port 8750`,
  };

  it("flags an orphaned managed server whose port is not owned", () => {
    expect(isLeakedManagedPlaywright(leaked, new Set())).toBe(true);
  });

  it("does not flag a server whose port is owned by a live session", () => {
    expect(isLeakedManagedPlaywright(leaked, new Set([8750]))).toBe(false);
  });

  it("does not flag when not reparented to init", () => {
    expect(isLeakedManagedPlaywright({ ...leaked, ppid: 4321 }, new Set())).toBe(false);
  });

  it("does not flag non-loopback bindings", () => {
    const wide: ProcessInfo = {
      ...leaked,
      args: `node ${bin} --headless --isolated --host 0.0.0.0 --port 8750`,
    };
    expect(isLeakedManagedPlaywright(wide, new Set())).toBe(false);
  });

  it("does not flag processes that are not our bin", () => {
    const other: ProcessInfo = {
      ...leaked,
      args: "node /some/other/cli.js --headless --host 127.0.0.1 --port 8750",
    };
    expect(isLeakedManagedPlaywright(other, new Set())).toBe(false);
  });

  it("does not flag when no --port is present", () => {
    const noPort: ProcessInfo = {
      ...leaked,
      args: `node ${bin} --headless --isolated --host 127.0.0.1`,
    };
    expect(isLeakedManagedPlaywright(noPort, new Set())).toBe(false);
  });
});

function spawnIdle(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Failed to spawn test process");
  child.unref();
  return pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("killProcessTree", () => {
  it("kills the root and every descendant, not just the root", async () => {
    // Real processes, tree shape declared through a stubbed `ps` (below the
    // process the sweep would find, a chromium child hangs off the server).
    const root = spawnIdle();
    const child = spawnIdle();
    const grandchild = spawnIdle();
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (_cmd: string, _args: string[], cb: (e: null, r: { stdout: string }) => void) => {
        cb(null, {
          stdout: [
            `${root} 1 node cli.js --headless`,
            `${child} ${root} chromium --type=zygote`,
            `${grandchild} ${child} chromium --type=renderer`,
            "",
          ].join("\n"),
        });
      },
    }));
    try {
      const mod = await import("../../../src/sidecars/playwright.js");
      await mod.killProcessTree(root);
      // SIGKILL is asynchronous from the signaller's point of view.
      await sleep(200);
      expect(alive(root)).toBe(false);
      expect(alive(child)).toBe(false);
      expect(alive(grandchild)).toBe(false);
    } finally {
      for (const pid of [root, child, grandchild]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already dead — the assertion above is what matters.
        }
      }
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("is exported for the leak sweep and tolerates an already-dead pid", async () => {
    const pid = spawnIdle();
    process.kill(pid, "SIGKILL");
    await sleep(100);
    await expect(killProcessTree(pid)).resolves.toBeUndefined();
  });
});

// Requirement: a session whose agent died leaves an orphaned server; the sweep
// must reap its whole tree, not only the root it matched.
describe("sweepLeakedPlaywright", () => {
  it("reaps the full process tree of a leaked server", async () => {
    const bin = resolvePlaywrightMcpBin();
    const server = spawnIdle();
    const browser = spawnIdle();
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (_cmd: string, _args: string[], cb: (e: null, r: { stdout: string }) => void) => {
        cb(null, {
          stdout: [
            `${server} 1 node ${bin} --headless --isolated --host 127.0.0.1 --port 8799`,
            `${browser} ${server} /opt/chromium --headless --remote-debugging-pipe`,
            "",
          ].join("\n"),
        });
      },
    }));
    try {
      const mod = await import("../../../src/sidecars/playwright.js");
      await expect(mod.sweepLeakedPlaywright(new Set<number>())).resolves.toBe(1);
      await sleep(200);
      expect(alive(server)).toBe(false);
      expect(alive(browser)).toBe(false);
    } finally {
      for (const pid of [server, browser]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already dead.
        }
      }
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("leaves a server alone when a live session still owns its port", async () => {
    const bin = resolvePlaywrightMcpBin();
    const server = spawnIdle();
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (_cmd: string, _args: string[], cb: (e: null, r: { stdout: string }) => void) => {
        cb(null, {
          stdout: `${server} 1 node ${bin} --headless --isolated --host 127.0.0.1 --port 8799\n`,
        });
      },
    }));
    try {
      const mod = await import("../../../src/sidecars/playwright.js");
      await expect(mod.sweepLeakedPlaywright(new Set<number>([8799]))).resolves.toBe(0);
      expect(alive(server)).toBe(true);
    } finally {
      process.kill(server, "SIGKILL");
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

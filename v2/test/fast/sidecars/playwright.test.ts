import { describe, expect, it } from "vitest";
import {
  isLeakedManagedPlaywright,
  playwrightMcpUrl,
  PLAYWRIGHT_SIDECAR_CONFIG,
  PLAYWRIGHT_SIDECAR_NAME,
  resolvePlaywrightMcpBin,
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
  it("runs the resolved bin directly via node with loopback binding", () => {
    const bin = resolvePlaywrightMcpBin();
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command.startsWith(`node ${shellEscape(bin)} `)).toBe(true);
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).not.toContain("npx");
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).toContain("--headless");
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).toContain("--isolated");
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).toContain("--host 127.0.0.1");
    expect(PLAYWRIGHT_SIDECAR_CONFIG.command).toContain(`--port $${SPUR_RESERVED_PORT_PLAYWRIGHT}`);
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

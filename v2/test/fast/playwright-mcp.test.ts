import { describe, expect, it } from "vitest";
import {
  buildPlaywrightSidecarConfig,
  isLeakedManagedPlaywright,
  resolvePlaywrightMcpBin,
  SPUR_PLAYWRIGHT_SESSION_ENV,
  SPUR_RESERVED_PORT_PLAYWRIGHT,
  type ProcessInfo,
} from "../../src/agents/playwright-mcp.js";
import { shellEscape } from "../../src/agents/shell-escape.js";

describe("buildPlaywrightSidecarConfig", () => {
  const sessionId = "20240101-abcd";
  const config = buildPlaywrightSidecarConfig(sessionId);

  it("runs the resolved bin directly via node with loopback binding", () => {
    const bin = resolvePlaywrightMcpBin();
    expect(config.command.startsWith(`node ${shellEscape(bin)} `)).toBe(true);
    expect(config.command).not.toContain("npx");
    expect(config.command).toContain("--headless");
    expect(config.command).toContain("--isolated");
    expect(config.command).toContain("--host 127.0.0.1");
    expect(config.command).toContain(`--port $${SPUR_RESERVED_PORT_PLAYWRIGHT}`);
  });

  it("does not pass --shared-browser-context", () => {
    expect(config.command).not.toContain("--shared-browser-context");
  });

  it("auto-starts and carries the session marker env", () => {
    expect(config.autoStart).toBe(true);
    expect(config.env?.[SPUR_PLAYWRIGHT_SESSION_ENV]).toBe(sessionId);
  });

  it("reserves an http port in 8730-8799 with no published url", () => {
    const port = config.ports?.["http"];
    expect(port?.env).toBe(SPUR_RESERVED_PORT_PLAYWRIGHT);
    expect(port?.start).toBe(8730);
    expect(port?.end).toBe(8799);
    expect(port?.url).toBeUndefined();
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

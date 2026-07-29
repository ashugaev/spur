import { describe, expect, it } from "vitest";
import { collectMcpBindings, resolveSessionSidecars } from "../../../src/sidecars/index.js";
import type { ProjectConfig, SidecarConfig } from "../../../src/types.js";

const PLAYWRIGHT_SIDECAR: SidecarConfig = {
  command: "node cli.js --port $SPUR_RESERVED_PORT_PLAYWRIGHT",
  autoStart: true,
  agents: ["claude", "codex"],
  ports: {
    http: { env: "SPUR_RESERVED_PORT_PLAYWRIGHT", start: 8730, end: 8799 },
  },
  mcp: { server: "playwright", portId: "http", path: "/mcp", clientHost: "localhost" },
};

const DEV_SIDECAR: SidecarConfig = {
  command: "pnpm dev",
  autoStart: true,
};

function project(sidecars: Record<string, SidecarConfig>): Pick<ProjectConfig, "sidecars"> {
  return { sidecars };
}

describe("resolveSessionSidecars", () => {
  it("is empty when the project has no sidecars configured (default off)", () => {
    expect(resolveSessionSidecars({ agent: "claude" }, project({}))).toEqual({});
  });

  it("includes an agent-scoped built-in for an eligible agent", () => {
    const resolved = resolveSessionSidecars(
      { agent: "claude" },
      project({ playwright: PLAYWRIGHT_SIDECAR }),
    );
    expect(resolved).toEqual({ playwright: PLAYWRIGHT_SIDECAR });
  });

  it("excludes an agent-scoped built-in for cursor even when configured on", () => {
    const resolved = resolveSessionSidecars(
      { agent: "cursor" },
      project({ playwright: PLAYWRIGHT_SIDECAR }),
    );
    expect(resolved).toEqual({});
  });

  it("keeps a user sidecar with no agents restriction for every agent", () => {
    const resolved = resolveSessionSidecars({ agent: "cursor" }, project({ dev: DEV_SIDECAR }));
    expect(resolved).toEqual({ dev: DEV_SIDECAR });
  });

  it("coexists a user sidecar and an agent-scoped built-in for an eligible agent", () => {
    const resolved = resolveSessionSidecars(
      { agent: "codex" },
      project({ dev: DEV_SIDECAR, playwright: PLAYWRIGHT_SIDECAR }),
    );
    expect(resolved).toEqual({ dev: DEV_SIDECAR, playwright: PLAYWRIGHT_SIDECAR });
  });

  it("returns an empty map when project is undefined", () => {
    expect(resolveSessionSidecars({ agent: "claude" }, undefined)).toEqual({});
  });
});

describe("collectMcpBindings", () => {
  it("builds a binding from the reserved port, defaulting host to localhost", () => {
    const bindings = collectMcpBindings(
      { playwright: PLAYWRIGHT_SIDECAR },
      { playwright: { SPUR_RESERVED_PORT_PLAYWRIGHT: 8742 } },
    );
    expect(bindings).toEqual([{ server: "playwright", url: "http://localhost:8742/mcp" }]);
  });

  it("skips a sidecar with no mcp config", () => {
    const bindings = collectMcpBindings(
      { dev: DEV_SIDECAR },
      { dev: { SPUR_RESERVED_PORT_DEV: 3000 } },
    );
    expect(bindings).toEqual([]);
  });

  it("skips a sidecar carrying mcp when no port has been reserved yet", () => {
    const bindings = collectMcpBindings({ playwright: PLAYWRIGHT_SIDECAR }, undefined);
    expect(bindings).toEqual([]);
  });

  it("honors an explicit clientHost override", () => {
    const bindings = collectMcpBindings(
      {
        widget: {
          ...PLAYWRIGHT_SIDECAR,
          mcp: { server: "widget", portId: "http", path: "/widget", clientHost: "widget.local" },
        },
      },
      { widget: { SPUR_RESERVED_PORT_PLAYWRIGHT: 9001 } },
    );
    expect(bindings).toEqual([{ server: "widget", url: "http://widget.local:9001/widget" }]);
  });
});

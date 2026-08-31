import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentProcessMatchers,
  agentSessionConfig,
  agentStateStrategy,
  agentWaitsForSubmitAck,
  extractCommandBinary,
  parseAgentName,
} from "../../src/agents/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("extractCommandBinary", () => {
  it("extracts a simple command", () => {
    expect(extractCommandBinary("claude --flag", "fallback")).toBe("claude");
  });

  it("skips env vars", () => {
    expect(extractCommandBinary("FOO=bar BAZ=1 node app.js", "fallback")).toBe("node");
  });

  it("extracts from single-quoted binary", () => {
    expect(extractCommandBinary("'/usr/bin/node' app.js", "fallback")).toBe("/usr/bin/node");
  });

  it("extracts from double-quoted binary", () => {
    expect(extractCommandBinary('"node" app.js', "fallback")).toBe("node");
  });

  it("returns fallback for empty string", () => {
    expect(extractCommandBinary("", "fallback")).toBe("fallback");
  });

  it("returns fallback for whitespace-only", () => {
    expect(extractCommandBinary("   ", "fallback")).toBe("fallback");
  });

  it("returns fallback when all tokens are env vars", () => {
    expect(extractCommandBinary("A=1 B=2", "fallback")).toBe("fallback");
  });
});

describe("parseAgentName", () => {
  it("accepts claude", () => {
    expect(parseAgentName("claude")).toBe("claude");
  });

  it("accepts codex", () => {
    expect(parseAgentName("codex")).toBe("codex");
  });

  it("accepts cursor", () => {
    expect(parseAgentName("cursor")).toBe("cursor");
  });

  it("throws for unknown agent", () => {
    expect(() => parseAgentName("gpt")).toThrow("Unsupported agent");
  });

  it("throws for empty string", () => {
    expect(() => parseAgentName("")).toThrow("Unsupported agent");
  });
});

describe("agent helpers", () => {
  it("uses strategy by agent type", () => {
    expect(agentStateStrategy("claude")).toBe("claude_jsonl");
    expect(agentStateStrategy("codex")).toBe("hook");
    expect(agentStateStrategy("cursor")).toBe("cursor_jsonl");
  });

  it("waits for submit ack for every agent", () => {
    expect(agentWaitsForSubmitAck("claude")).toBe(true);
    expect(agentWaitsForSubmitAck("codex")).toBe(true);
    expect(agentWaitsForSubmitAck("cursor")).toBe(true);
  });

  it("adds cursor process fallbacks without duplicating the derived binary", () => {
    expect(agentProcessMatchers("cursor", "/opt/bin/cursor-agent --force")).toEqual([
      "cursor-agent",
      "agent",
    ]);
    expect(agentProcessMatchers("cursor", "agent --force")).toEqual(["agent", "cursor-agent"]);
  });

  it("appends the canonical binary name so an exec'ing wrapper stays matchable", () => {
    expect(
      agentProcessMatchers(
        "codex",
        "CODEX_HOME='/home/u/.spur/session-tools/s1/codex-home' /home/u/.local/bin/codex-spur-wrapper.sh --enable hooks",
      ),
    ).toEqual(["codex-spur-wrapper.sh", "codex"]);
    expect(agentProcessMatchers("claude", "/opt/bin/claude-wrap.sh --resume")).toEqual([
      "claude-wrap.sh",
      "claude",
    ]);
    expect(agentProcessMatchers("opencode", "/opt/bin/oc-wrap.sh")).toEqual([
      "oc-wrap.sh",
      "opencode",
    ]);
  });

  it("dedupes a direct launch to a single matcher", () => {
    expect(agentProcessMatchers("codex", "codex --model gpt-5.6")).toEqual(["codex"]);
  });

  it("still appends the canonical name when the override IS the wrapper (I1 no-op guard)", () => {
    vi.stubEnv("SPUR_CODEX_BIN", "/home/u/.local/bin/codex-spur-wrapper.sh");
    expect(agentProcessMatchers("codex", "")).toEqual(["codex-spur-wrapper.sh", "codex"]);
  });

  it("scopes Cursor runtime state to the session data dir", () => {
    expect(agentSessionConfig("claude", { dataDir: "/tmp/spur-data", sessionId: "api-1" })).toEqual(
      {},
    );
    expect(agentSessionConfig("cursor", { dataDir: "/tmp/spur-data", sessionId: "api-1" })).toEqual(
      {
        env: {
          CURSOR_CONFIG_DIR: "/tmp/spur-data/cursor/api-1",
        },
        planOptions: {
          cursorConfigDir: "/tmp/spur-data/cursor/api-1",
        },
      },
    );
  });

  it("adds the restrict-writes gate env only for cursor sessions with restrictWrites", () => {
    expect(
      agentSessionConfig("cursor", {
        dataDir: "/tmp/spur-data",
        sessionId: "api-1",
        restrictWrites: true,
      }),
    ).toEqual({
      env: {
        CURSOR_CONFIG_DIR: "/tmp/spur-data/cursor/api-1",
        SPUR_CURSOR_RESTRICT_WRITES: "1",
      },
      planOptions: {
        cursorConfigDir: "/tmp/spur-data/cursor/api-1",
      },
    });

    expect(
      agentSessionConfig("cursor", {
        dataDir: "/tmp/spur-data",
        sessionId: "api-1",
        restrictWrites: false,
      }),
    ).toEqual({
      env: {
        CURSOR_CONFIG_DIR: "/tmp/spur-data/cursor/api-1",
      },
      planOptions: {
        cursorConfigDir: "/tmp/spur-data/cursor/api-1",
      },
    });

    expect(
      agentSessionConfig("claude", {
        dataDir: "/tmp/spur-data",
        sessionId: "api-1",
        restrictWrites: true,
      }),
    ).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import {
  agentProcessMatchers,
  agentSessionConfig,
  agentStateStrategy,
  agentWaitsForSubmitAck,
  extractCommandBinary,
  parseAgentName,
} from "../../src/agents/index.js";

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
});

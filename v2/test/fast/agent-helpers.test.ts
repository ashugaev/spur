import { describe, expect, it } from "vitest";
import { extractCommandBinary, parseAgentName } from "../../src/agents/index.js";

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

  it("throws for unknown agent", () => {
    expect(() => parseAgentName("gpt")).toThrow("Unsupported agent");
  });

  it("throws for empty string", () => {
    expect(() => parseAgentName("")).toThrow("Unsupported agent");
  });
});

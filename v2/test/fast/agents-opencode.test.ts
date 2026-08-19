import { describe, expect, it, vi } from "vitest";
import {
  buildOpenCodePlan,
  buildOpenCodeConfig,
  buildOpenCodeResumePlan,
  diffOpenCodeSessionIds,
  isSupportedOpenCodeVersion,
  OPENCODE_RESTRICT_WRITES_CONFIG,
  parseOpenCodeExport,
  parseOpenCodeState,
} from "../../src/agents/opencode.js";

describe("OpenCode adapter", () => {
  it("launches with permission auto-approval and a selected model", () => {
    vi.stubEnv("SPUR_OPENCODE_BIN", "/opt/Open Code/opencode");
    expect(buildOpenCodePlan("work", { model: "openai/gpt-5" })).toEqual({
      launchCommand: "'/opt/Open Code/opencode' --auto --model 'openai/gpt-5'",
      initialMessage: "work",
      readyMarkers: ["OpenCode", "Ask anything"],
    });
    vi.unstubAllEnvs();
  });

  it("enforces the supported CLI floor", () => {
    expect(isSupportedOpenCodeVersion("1.18.17")).toBe(false);
    expect(isSupportedOpenCodeVersion("v1.18.18")).toBe(true);
    expect(isSupportedOpenCodeVersion("1.19.0-dev")).toBe(true);
    expect(isSupportedOpenCodeVersion("unknown")).toBe(false);
  });

  it("denies edit tools and git writes in restrict-writes mode", () => {
    expect(JSON.parse(OPENCODE_RESTRICT_WRITES_CONFIG)).toEqual({
      permission: {
        edit: "deny",
        bash: { "*": "allow", "git commit*": "deny", "git push*": "deny" },
      },
    });
  });

  it("merges session MCP bindings with restrict-writes policy", () => {
    expect(
      JSON.parse(
        buildOpenCodeConfig([{ server: "playwright", url: "http://127.0.0.1:5001/mcp" }], true) ??
          "{}",
      ),
    ).toEqual({
      mcp: {
        playwright: {
          type: "remote",
          url: "http://127.0.0.1:5001/mcp",
          enabled: true,
        },
      },
      permission: {
        edit: "deny",
        bash: { "*": "allow", "git commit*": "deny", "git push*": "deny" },
      },
    });
  });

  it("resumes the exact native session id", () => {
    expect(buildOpenCodeResumePlan("ses_123", "opencode").launchCommand).toBe(
      "'opencode' --auto --session 'ses_123'",
    );
  });

  it("binds only the single session created after launch", () => {
    const baseline = { worktreePath: "/repo", sessionIds: new Set(["ses_existing"]) };
    expect(diffOpenCodeSessionIds(baseline, new Set(["ses_existing", "ses_owned"]))).toBe(
      "ses_owned",
    );
    expect(diffOpenCodeSessionIds(baseline, new Set(["ses_existing"]))).toBeNull();
    expect(() =>
      diffOpenCodeSessionIds(baseline, new Set(["ses_existing", "ses_sibling_a", "ses_sibling_b"])),
    ).toThrow("refusing ambiguous identity");
  });

  it("reads user and assistant text from an exported session", () => {
    expect(
      parseOpenCodeExport({
        messages: [
          { info: { role: "user" }, parts: [{ type: "text", text: "one" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "two" }] },
          { info: { role: "assistant" }, parts: [{ type: "tool", name: "bash" }] },
        ],
      }),
    ).toEqual([
      { kind: "message", role: "user", text: "one" },
      { kind: "message", role: "assistant", text: "two" },
    ]);
  });

  it("classifies structured busy, completed, and error messages", () => {
    expect(parseOpenCodeState({ messages: [{ info: { role: "user" } }] })).toEqual({
      state: "working",
      reason: "last role=user",
    });
    expect(
      parseOpenCodeState({
        messages: [{ info: { role: "assistant", time: { completed: 123 } } }],
      }),
    ).toEqual({ state: "waiting", reason: "assistant completed" });
    expect(
      parseOpenCodeState({
        messages: [{ info: { role: "assistant", error: { name: "ApiError" } } }],
      }),
    ).toEqual({ state: "error", reason: "assistant error" });
    expect(parseOpenCodeState({ messages: [{ info: { role: "assistant", time: {} } }] })).toEqual({
      state: "working",
      reason: "assistant incomplete",
    });
  });

  it("classifies structured permission, question, retry, and rate-limit states", () => {
    expect(
      parseOpenCodeState({
        permission: [{ id: "per_1", sessionID: "ses_1" }],
        messages: [{ info: { role: "assistant", time: {} } }],
      }),
    ).toEqual({ state: "needs_input", reason: "permission pending" });
    expect(
      parseOpenCodeState({
        messages: [
          { info: { role: "assistant", time: {} }, parts: [{ type: "question", id: "q_1" }] },
        ],
      }),
    ).toEqual({ state: "needs_input", reason: "question pending" });
    expect(
      parseOpenCodeState({
        messages: [
          {
            info: { role: "assistant", time: {} },
            parts: [{ type: "retry", attempt: 2, error: { message: "server unavailable" } }],
          },
        ],
      }),
    ).toEqual({ state: "working", reason: "assistant retry" });
    expect(
      parseOpenCodeState({
        messages: [
          {
            info: {
              role: "assistant",
              error: { name: "APIError", data: { statusCode: 429, message: "Too Many Requests" } },
            },
          },
        ],
      }),
    ).toEqual({ state: "rate_limited", reason: "assistant rate limit" });
    expect(parseOpenCodeState({ messages: "malformed" })).toBeNull();
  });
});

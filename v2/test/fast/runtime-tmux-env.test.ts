import { describe, expect, it } from "vitest";
import { _buildPaneEnvForTests as buildPaneEnv } from "../../src/runtime-tmux.js";

// Regression guard for the PR #622 review finding (comment 3671205297): a
// caller-supplied env (e.g. agents.*.env / extraEnv config) must not be able
// to re-inject a Claude Code identity var that was just stripped from the
// inherited process.env half. buildPaneEnv merges process.env with the
// caller env and must strip CLAUDE_IDENTITY_ENV_KEYS from that *merged*
// result, not just from process.env before the merge.

describe("buildPaneEnv", () => {
  it("strips a Claude identity var even when the caller env re-injects it", () => {
    const env = buildPaneEnv({ CLAUDECODE: "1", FOO: "bar" });

    expect(Object.keys(env)).not.toContain("CLAUDECODE");
    expect(env.FOO).toBe("bar");
  });

  it("strips all three identity keys when supplied via caller env", () => {
    const env = buildPaneEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "foreign-session",
      CLAUDE_CODE_CHILD_SESSION: "1",
    });

    const keys = Object.keys(env);
    expect(keys).not.toContain("CLAUDECODE");
    expect(keys).not.toContain("CLAUDE_CODE_SESSION_ID");
    expect(keys).not.toContain("CLAUDE_CODE_CHILD_SESSION");
    expect(Object.values(env)).not.toContain("foreign-session");
  });

  it("still emits caller-supplied non-identity vars", () => {
    expect(buildPaneEnv({ MY_VAR: "value" }).MY_VAR).toBe("value");
  });

  it("drops keys tmux sets itself", () => {
    const keys = Object.keys(
      buildPaneEnv({
        SHELL: "/bin/sentinel-shell",
        TERM: "sentinel-term",
        TERM_PROGRAM: "x",
        TERM_PROGRAM_VERSION: "x",
        TMUX: "x",
        TMUX_PANE: "x",
        PWD: "/sentinel-pwd",
        KEPT: "1",
      }),
    );

    for (const key of [
      "SHELL",
      "TERM",
      "TERM_PROGRAM",
      "TERM_PROGRAM_VERSION",
      "TMUX",
      "TMUX_PANE",
      "PWD",
    ]) {
      expect(keys).not.toContain(key);
    }
    expect(keys).toContain("KEPT");
  });

  it("drops keys sh cannot export", () => {
    const keys = Object.keys(buildPaneEnv({ "BAD%KEY": "1", "BASH_FUNC_x%%": "() { :; }" }));

    expect(keys).not.toContain("BAD%KEY");
    expect(keys).not.toContain("BASH_FUNC_x%%");
  });

  it("keeps an empty per-call value", () => {
    expect(buildPaneEnv({ EMPTY_VAR: "" }).EMPTY_VAR).toBe("");
  });

  it("throws on a NUL value naming the key, never the value", () => {
    expect(() => buildPaneEnv({ NUL_VAR: "secret\0tail" })).toThrow(/NUL_VAR/);
    expect(() => buildPaneEnv({ NUL_VAR: "secret\0tail" })).not.toThrow(/secret/);
  });
});

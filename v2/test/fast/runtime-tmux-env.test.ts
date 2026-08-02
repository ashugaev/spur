import { describe, expect, it } from "vitest";
import { _buildEnvArgsForTests as buildEnvArgs } from "../../src/runtime-tmux.js";

// Regression guard for the PR #622 review finding (comment 3671205297): a
// caller-supplied env (e.g. agents.*.env / extraEnv config) must not be able
// to re-inject a Claude Code identity var that was just stripped from the
// inherited process.env half. buildEnvArgs merges process.env with the
// caller env and must strip CLAUDE_IDENTITY_ENV_KEYS from that *merged*
// result, not just from process.env before the merge.

// buildEnvArgs pushes flat "-e", "KEY=VALUE" pairs, so every emitted key
// lives at an odd index. Extract just the keys to assert absence/presence
// without depending on the unrelated process.env noise also present in
// every call's output.
function emittedKeys(args: string[]): string[] {
  return args.filter((_, index) => index % 2 === 1).map((entry) => entry.split("=")[0] ?? "");
}

describe("buildEnvArgs", () => {
  it("strips a Claude identity var even when the caller env re-injects it", () => {
    const args = buildEnvArgs({ CLAUDECODE: "1", FOO: "bar" });

    expect(emittedKeys(args)).not.toContain("CLAUDECODE");
    expect(args).toContain("FOO=bar");
  });

  it("strips all three identity keys when supplied via caller env", () => {
    const args = buildEnvArgs({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "foreign-session",
      CLAUDE_CODE_CHILD_SESSION: "1",
    });

    const keys = emittedKeys(args);
    expect(keys).not.toContain("CLAUDECODE");
    expect(keys).not.toContain("CLAUDE_CODE_SESSION_ID");
    expect(keys).not.toContain("CLAUDE_CODE_CHILD_SESSION");
    expect(args.join("\n")).not.toContain("foreign-session");
  });

  it("still emits caller-supplied non-identity vars", () => {
    const args = buildEnvArgs({ MY_VAR: "value" });

    expect(args).toContain("MY_VAR=value");
  });
});

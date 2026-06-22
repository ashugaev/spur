import { describe, expect, it } from "vitest";
import { isPlausibleGitRef } from "../../src/branch-name.js";

describe("isPlausibleGitRef", () => {
  const accept = [
    "feature/login-rate-limit",
    "main",
    "release/v1.2.3",
    "fix_bug-42",
    "user/123/topic",
  ];
  const reject: [string, string][] = [
    ["", "empty"],
    ["feature branch", "inner whitespace"],
    [`feat${String.fromCharCode(9)}branch`, "tab"],
    [`feat${String.fromCharCode(1)}branch`, "control char"],
    ["feat~1", "tilde"],
    ["feat^head", "caret"],
    ["feat:colon", "colon"],
    ["feat?q", "question mark"],
    ["feat*glob", "asterisk"],
    ["feat[set", "open bracket"],
    ["feat\\back", "backslash"],
    ["/leading", "leading slash"],
    ["trailing/", "trailing slash"],
    ["a..b", "double dot"],
    ["ref@{0}", "reflog at-brace"],
    ["feature.lock", "trailing .lock"],
  ];

  for (const token of accept) {
    it(`accepts ${token}`, () => {
      expect(isPlausibleGitRef(token)).toBe(true);
    });
  }

  for (const [token, why] of reject) {
    it(`rejects ${why}`, () => {
      expect(isPlausibleGitRef(token)).toBe(false);
    });
  }
});

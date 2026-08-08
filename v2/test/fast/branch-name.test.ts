import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertBranchNameMatches,
  compileBranchNamingRegex,
  isPlausibleGitRef,
  matchesBranchNaming,
  normalizeBranchName,
} from "../../src/branch-name.js";

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

describe("normalizeBranchName", () => {
  const cases: [string, string][] = [
    ["Test 2", "test-2"],
    ["feature/X Y Z", "feature/x-y-z"],
    ["My---Branch__name", "my-branch-name"],
    [".foo", "foo"],
    ["bar.lock", "bar"],
    ["WEBDEV-4321 fix login", "webdev-4321-fix-login"],
    ["", ""],
    ["!!!", ""],
    ["feature/already-good", "feature/already-good"],
    ["café", "cafe"],
    ["Тест", ""],
    ["foo..bar", "foo.bar"],
    ["a...b", "a.b"],
    ["x.lock.lock", "x"],
    ["fix foo..bar", "fix-foo.bar"],
    // per-component git-illegal inputs must not survive
    ["feature//x", "feature/x"],
    ["foo/.bar", "foo/bar"],
    ["x.lock/y", "x/y"],
    ["a/../b", "a/b"],
    ["feature/", "feature"],
  ];

  for (const [input, expected] of cases) {
    it(`normalizes ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeBranchName(input)).toBe(expected);
    });
  }

  // normalizeBranchName is hand-mirrored in packages/web/src/lib/branch-name.ts
  // (web cannot import from v2). The "will create" preview and the
  // /branches/exists lookup are only correct if both copies stay byte-identical.
  it("stays byte-identical to the web copy", () => {
    const extract = (path: string): string => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const match = source.match(/export function normalizeBranchName[\s\S]*?\n}/);
      if (!match) throw new Error(`normalizeBranchName not found in ${path}`);
      return match[0];
    };
    expect(extract("../../../packages/web/src/lib/branch-name.ts")).toBe(
      extract("../../src/branch-name.ts"),
    );
  });
});

describe("compileBranchNamingRegex", () => {
  it("returns a working RegExp for a valid pattern", () => {
    const re = compileBranchNamingRegex("^feature/[a-z]+$", "branchNaming");
    expect(re.test("feature/login")).toBe(true);
    expect(re.test("main")).toBe(false);
  });

  it("throws on an invalid regex pattern", () => {
    expect(() => compileBranchNamingRegex("[", "branchNaming")).toThrow(
      /branchNaming\.regex must be a valid JavaScript regular expression/,
    );
  });
});

describe("assertBranchNameMatches", () => {
  it("does nothing when branchNaming is undefined", () => {
    expect(() => assertBranchNameMatches("anything", undefined, "branch")).not.toThrow();
  });

  it("does nothing when the branch matches the configured regex", () => {
    expect(() =>
      assertBranchNameMatches("feature/test-cov", { regex: "^feature/[a-z-]+$" }, "branch"),
    ).not.toThrow();
  });

  it("throws when the branch does not match", () => {
    expect(() =>
      assertBranchNameMatches("bad branch", { regex: "^feature/[a-z-]+$" }, "branch"),
    ).toThrow(/branch "bad branch" must match \^feature/);
  });
});

describe("matchesBranchNaming", () => {
  it("returns true when branch matches the configured regex", () => {
    expect(matchesBranchNaming("WEBDEV-4964", { regex: "^[A-Z]+-[0-9]+$" })).toBe(true);
  });

  it("returns false when branch does not match the configured regex", () => {
    expect(matchesBranchNaming("webdev 4964", { regex: "^[A-Z]+-[0-9]+$" })).toBe(false);
  });

  it("returns true when no branchNaming config is provided", () => {
    expect(matchesBranchNaming("anything", undefined)).toBe(true);
  });
});

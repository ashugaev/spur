import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
  },
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

import { assertValidEnvVarName, parseEnvFile, resolveEnvSecret } from "@/lib/env-secret";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("parseEnvFile", () => {
  it("strips surrounding double quotes from values", () => {
    expect(parseEnvFile('TOKEN="abc"')).toEqual({ TOKEN: "abc" });
  });

  it("strips surrounding single quotes from values", () => {
    expect(parseEnvFile("TOKEN='abc'")).toEqual({ TOKEN: "abc" });
  });

  it("ignores comments and blank lines", () => {
    expect(parseEnvFile("# comment\n\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  it("ignores lines without an equals separator", () => {
    expect(parseEnvFile("no-separator-here\nFOO=bar")).toEqual({ FOO: "bar" });
  });
});

describe("resolveEnvSecret", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("prefers the file value over process.env", () => {
    process.env.TOKEN = "from-process";
    expect(resolveEnvSecret("TOKEN", { TOKEN: "from-file" })).toBe("from-file");
  });

  it("falls back to process.env when the file value is empty", () => {
    process.env.TOKEN = "from-process";
    expect(resolveEnvSecret("TOKEN", { TOKEN: "  " })).toBe("from-process");
  });

  it("returns undefined when nothing is set", () => {
    delete process.env.TOKEN;
    expect(resolveEnvSecret("TOKEN", {})).toBeUndefined();
  });
});

describe("assertValidEnvVarName", () => {
  it("rejects lowercase names", () => {
    expect(() => assertValidEnvVarName("token", "label")).toThrow(/label must match/);
  });

  it("accepts uppercase names with digits and underscores", () => {
    expect(() => assertValidEnvVarName("MY_TOKEN_2", "label")).not.toThrow();
  });
});

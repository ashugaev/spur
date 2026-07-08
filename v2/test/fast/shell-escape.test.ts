import { describe, expect, it } from "vitest";
import { shellEscape } from "../../src/agents/shell-escape.js";

describe("shellEscape", () => {
  it("wraps a plain word in single quotes", () => {
    expect(shellEscape("foo")).toBe("'foo'");
  });

  it("escapes an embedded single quote with the '\\'' pattern", () => {
    expect(shellEscape("foo'bar")).toBe("'foo'\\''bar'");
  });

  it("returns '' for an empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("preserves spaces inside the quoted value", () => {
    expect(shellEscape("foo bar baz")).toBe("'foo bar baz'");
  });
});

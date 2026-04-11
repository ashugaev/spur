import { describe, expect, it } from "vitest";
import { normalizeLines, appendedLines } from "../../src/event-sources/service.js";

describe("normalizeLines", () => {
  it("splits, trims trailing whitespace, and removes blank lines", () => {
    expect(normalizeLines("hello  \n\n  world  \n")).toEqual(["hello", "  world"]);
  });

  it("returns empty array for empty string", () => {
    expect(normalizeLines("")).toEqual([]);
  });

  it("handles \\r\\n line endings", () => {
    expect(normalizeLines("line1\r\nline2\r\n")).toEqual(["line1", "line2"]);
  });
});

describe("appendedLines", () => {
  it("returns all of next when previous is empty", () => {
    expect(appendedLines([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns empty when arrays are identical", () => {
    expect(appendedLines(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("returns new lines for partial overlap", () => {
    expect(appendedLines(["a", "b", "c"], ["b", "c", "d"])).toEqual(["d"]);
  });

  it("returns all of next when there is no overlap", () => {
    expect(appendedLines(["x", "y"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns empty when next is empty", () => {
    expect(appendedLines(["a", "b"], [])).toEqual([]);
  });
});

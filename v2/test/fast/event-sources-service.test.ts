import { describe, expect, it } from "vitest";
import { appendedLines, normalizeLines } from "../../src/event-sources/service.js";

describe("normalizeLines", () => {
  it("splits on newlines and keeps non-empty lines", () => {
    expect(normalizeLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("trims trailing whitespace from each line", () => {
    expect(normalizeLines("alpha   \nbeta\t\n")).toEqual(["alpha", "beta"]);
  });

  it("drops blank and whitespace-only lines", () => {
    expect(normalizeLines("first\n\n   \nsecond")).toEqual(["first", "second"]);
  });
});

describe("appendedLines", () => {
  it("returns an empty array when next is fully contained in previous tail", () => {
    expect(appendedLines(["a", "b", "c"], ["b", "c"])).toEqual([]);
  });

  it("returns only the new tail when previous and next overlap partially", () => {
    expect(appendedLines(["a", "b", "c"], ["b", "c", "d"])).toEqual(["d"]);
  });

  it("returns next as-is when there is no overlap", () => {
    expect(appendedLines(["a", "b"], ["x", "y"])).toEqual(["x", "y"]);
  });

  it("returns next as-is when previous is empty", () => {
    expect(appendedLines([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("returns an empty array when next is empty", () => {
    expect(appendedLines(["a", "b"], [])).toEqual([]);
  });
});

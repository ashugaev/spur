import { describe, expect, it } from "vitest";
import { semverGt } from "@/lib/semver";

describe("semverGt", () => {
  it("returns false when versions are equal", () => {
    expect(semverGt("1.2.3", "1.2.3")).toBe(false);
  });

  it("returns true when left is strictly greater", () => {
    expect(semverGt("1.2.4", "1.2.3")).toBe(true);
    expect(semverGt("1.3.0", "1.2.9")).toBe(true);
    expect(semverGt("2.0.0", "1.9.9")).toBe(true);
  });

  it("returns false when left is strictly less", () => {
    expect(semverGt("1.2.3", "1.2.4")).toBe(false);
    expect(semverGt("1.2.9", "1.3.0")).toBe(false);
    expect(semverGt("1.9.9", "2.0.0")).toBe(false);
  });

  it("returns false for malformed input", () => {
    expect(semverGt("1.2", "1.2.3")).toBe(false);
    expect(semverGt("1.2.3", "1.2")).toBe(false);
    expect(semverGt("v1.2.3", "1.2.3")).toBe(false);
    expect(semverGt("1.2.3-beta", "1.2.3")).toBe(false);
    expect(semverGt("", "1.2.3")).toBe(false);
    expect(semverGt("abc", "def")).toBe(false);
  });
});

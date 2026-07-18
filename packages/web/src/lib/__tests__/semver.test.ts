import { describe, expect, it } from "vitest";
import { updateSeverity } from "@/lib/semver";

describe("updateSeverity", () => {
  it("returns none for an equal version", () => {
    expect(updateSeverity("1.4.0", "1.4.0")).toBe("none");
  });

  it("returns none for a downgrade", () => {
    expect(updateSeverity("1.3.0", "1.4.0")).toBe("none");
  });

  it("returns none for non-strict-semver input", () => {
    expect(updateSeverity("1.2", "1.1.0")).toBe("none");
    expect(updateSeverity("dev", "1.1.0")).toBe("none");
    expect(updateSeverity("1.2.0", "dev")).toBe("none");
  });

  it("returns update for a patch bump", () => {
    expect(updateSeverity("1.4.1", "1.4.0")).toBe("update");
  });

  it("returns update for a minor bump", () => {
    expect(updateSeverity("1.5.0", "1.4.0")).toBe("update");
  });

  it("returns major for a major bump", () => {
    expect(updateSeverity("2.0.0", "1.4.0")).toBe("major");
  });
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeBuildId, getBuildId } from "../../src/build-identity.js";

describe("runtime build identity", () => {
  it("covers nested executable paths and bytes, ignoring build metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "spur-build-identity-"));
    try {
      mkdirSync(join(directory, "nested"));
      writeFileSync(join(directory, "cli.js"), "runtime");
      writeFileSync(join(directory, "nested", "route.js"), "handler");
      const initial = computeBuildId(directory);
      writeFileSync(join(directory, ".tsbuildinfo"), "cache");
      expect(computeBuildId(directory)).toBe(initial);
      writeFileSync(join(directory, "nested", "route.js"), "changed");
      expect(computeBuildId(directory)).not.toBe(initial);
      expect(getBuildId()).toMatch(/^[a-f0-9]{64}$/);
      expect(getBuildId()).toBe(getBuildId());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

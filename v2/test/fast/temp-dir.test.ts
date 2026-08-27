import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTempDir } from "../../src/temp-dir.js";
import { createTempDir } from "../helpers/common.js";

describe("resolveTempDir", () => {
  const originalTmpdir = process.env["TMPDIR"];

  afterEach(() => {
    if (originalTmpdir === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = originalTmpdir;
    }
  });

  it("returns a path that exists when TMPDIR points at a non-existent directory", async () => {
    const parent = await createTempDir("spur-temp-dir-test-");
    process.env["TMPDIR"] = join(parent, "gone");

    const resolved = resolveTempDir();

    expect(existsSync(resolved)).toBe(true);
    expect(statSync(resolved).isDirectory()).toBe(true);
  });

  it("falls back to /tmp when TMPDIR points at a regular file", async () => {
    const parent = await createTempDir("spur-temp-dir-test-");
    const filePath = join(parent, "not-a-directory");
    writeFileSync(filePath, "not a directory");
    process.env["TMPDIR"] = filePath;

    const resolved = resolveTempDir();

    expect(resolved).toBe("/tmp");
  });
});

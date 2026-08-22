import type * as FsModule from "node:fs";
import { lstat, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "../../src/config.js";
import { createTempDir } from "../helpers/common.js";
import { readAutoUpdateFlag, writeAutoUpdateFlag } from "../../src/auto-update-config.js";

async function tempConfig(content: string): Promise<string> {
  const dir = await createTempDir("spur-auto-update-config-");
  const path = join(dir, "spur.yaml");
  await writeFile(path, content, "utf8");
  return path;
}

describe("readAutoUpdateFlag", () => {
  it("returns false with a non-null error for a missing file", async () => {
    const dir = await createTempDir("spur-auto-update-config-");
    const result = readAutoUpdateFlag(join(dir, "does-not-exist.yaml"));
    expect(result.autoUpdate).toBe(false);
    expect(result.error).not.toBeNull();
  });

  it("returns false with a non-null error for an unparseable config", async () => {
    const path = await tempConfig('autoUpdate: "yes"\n');
    const result = readAutoUpdateFlag(path);
    expect(result.autoUpdate).toBe(false);
    expect(result.error).toBe("autoUpdate must be a boolean");
  });

  it("returns false with no error when the key is absent", async () => {
    const path = await tempConfig("projects: {}\n");
    expect(readAutoUpdateFlag(path)).toEqual({ autoUpdate: false, error: null });
  });

  it("returns the explicit value with no error", async () => {
    const path = await tempConfig("autoUpdate: true\nprojects: {}\n");
    expect(readAutoUpdateFlag(path)).toEqual({ autoUpdate: true, error: null });
  });
});

describe("writeAutoUpdateFlag", () => {
  it("preserves a leading comment, an inline comment, and key order while flipping the value", async () => {
    const path = await tempConfig(
      [
        "# leading comment",
        "autoUpdate: true # inline comment",
        "projects:",
        "  demo:",
        "    path: /tmp/demo",
        "",
      ].join("\n"),
    );

    const result = writeAutoUpdateFlag(path, false);

    expect(result).toEqual({ ok: true, autoUpdate: false });
    const text = await readFile(path, "utf8");
    expect(text).toContain("# leading comment");
    expect(text).toContain("autoUpdate: false # inline comment");
    expect(text.indexOf("autoUpdate")).toBeLessThan(text.indexOf("projects"));
  });

  it("adds the key when absent, preserving existing content", async () => {
    const path = await tempConfig("projects:\n  demo:\n    path: /tmp/demo\n");

    const result = writeAutoUpdateFlag(path, true);

    expect(result).toEqual({ ok: true, autoUpdate: true });
    const text = await readFile(path, "utf8");
    expect(text).toContain("autoUpdate: true");
    expect(text).toContain("path: /tmp/demo");
  });

  it("is a no-op when the effective value already matches (file mtime unchanged)", async () => {
    const path = await tempConfig("autoUpdate: true\nprojects: {}\n");
    const before = await readFile(path, "utf8");

    const result = writeAutoUpdateFlag(path, true);

    expect(result).toEqual({ ok: true, autoUpdate: true });
    const after = await readFile(path, "utf8");
    expect(after).toBe(before);
  });

  it("is a no-op disarming a config with no autoUpdate key at all", async () => {
    const path = await tempConfig("projects: {}\n");
    const before = await readFile(path, "utf8");

    const result = writeAutoUpdateFlag(path, false);

    expect(result).toEqual({ ok: true, autoUpdate: false });
    const after = await readFile(path, "utf8");
    expect(after).toBe(before);
  });

  it("writes cleanly into an empty file", async () => {
    const path = await tempConfig("");

    const result = writeAutoUpdateFlag(path, false);

    expect(result).toEqual({ ok: true, autoUpdate: false });
    expect(readAutoUpdateFlag(path)).toEqual({ autoUpdate: false, error: null });
  });

  it("writes cleanly into a comment-only file", async () => {
    const path = await tempConfig("# nothing here yet\n");

    const result = writeAutoUpdateFlag(path, false);

    expect(result).toEqual({ ok: true, autoUpdate: false });
    expect(readAutoUpdateFlag(path)).toEqual({ autoUpdate: false, error: null });
    const text = await readFile(path, "utf8");
    expect(text).toContain("# nothing here yet");
  });

  it("returns not_mapping for a top-level sequence", async () => {
    const path = await tempConfig("- a\n- b\n");
    expect(writeAutoUpdateFlag(path, true)).toEqual({
      ok: false,
      reason: "not_mapping",
      message: expect.any(String),
    });
  });

  it("returns not_mapping for a bare scalar document", async () => {
    const path = await tempConfig("hello\n");
    expect(writeAutoUpdateFlag(path, true)).toEqual({
      ok: false,
      reason: "not_mapping",
      message: expect.any(String),
    });
  });

  it("returns not_mapping for a ----only document", async () => {
    const path = await tempConfig("---\n");
    expect(writeAutoUpdateFlag(path, true)).toEqual({
      ok: false,
      reason: "not_mapping",
      message: expect.any(String),
    });
  });

  it("returns missing for a deleted config", async () => {
    const dir = await createTempDir("spur-auto-update-config-");
    const path = join(dir, "gone.yaml");
    expect(writeAutoUpdateFlag(path, true)).toEqual({
      ok: false,
      reason: "missing",
      message: expect.any(String),
    });
  });

  it("returns config_invalid when the on-disk config already has a bad field", async () => {
    const path = await tempConfig('autoUpdate: "yes"\nprojects: {}\n');
    expect(writeAutoUpdateFlag(path, true)).toEqual({
      ok: false,
      reason: "config_invalid",
      message: "autoUpdate must be a boolean",
    });
  });

  it("rewrites the realpath target and leaves the symlink itself in place", async () => {
    const dir = await createTempDir("spur-auto-update-config-");
    const targetPath = join(dir, "target.yaml");
    const linkPath = join(dir, "spur.yaml");
    await writeFile(targetPath, "projects: {}\n", "utf8");
    await symlink(targetPath, linkPath);

    const result = writeAutoUpdateFlag(linkPath, true);

    expect(result).toEqual({ ok: true, autoUpdate: true });
    const targetText = await readFile(targetPath, "utf8");
    expect(targetText).toContain("autoUpdate: true");
    const linkStat = await lstat(linkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  describe("conflict detection", () => {
    afterEach(async () => {
      vi.doUnmock("node:fs");
      vi.resetModules();
    });

    it("returns conflict and preserves the concurrent edit when the file changes between the two stats", async () => {
      const path = await tempConfig("autoUpdate: true\nprojects: {}\n");

      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof FsModule>("node:fs");
        let calls = 0;
        return {
          ...actual,
          statSync: (...args: Parameters<typeof actual.statSync>) => {
            calls += 1;
            if (calls === 2) {
              actual.writeFileSync(path, "autoUpdate: true\nprojects: {}\nconcurrent: 1\n", "utf8");
            }
            return actual.statSync(...args);
          },
        };
      });

      const { writeAutoUpdateFlag: mockedWrite } = await import("../../src/auto-update-config.js");
      const result = mockedWrite(path, false);

      expect(result).toEqual({
        ok: false,
        reason: "conflict",
        message: expect.any(String),
      });
      const finalText = await readFile(path, "utf8");
      expect(finalText).toContain("concurrent: 1");

      const remaining = await readdir(join(path, ".."));
      expect(remaining.some((name) => name.includes(".tmp."))).toBe(false);
    });
  });

  describe("invalid_output handling", () => {
    afterEach(async () => {
      vi.doUnmock("../../src/config.js");
      vi.resetModules();
    });

    it("returns invalid_output rather than renaming when the produced text does not reparse", async () => {
      const path = await tempConfig("autoUpdate: true\nprojects: {}\n");

      vi.resetModules();
      vi.doMock("../../src/config.js", async () => {
        const actual = await vi.importActual<typeof ConfigModule>("../../src/config.js");
        let calls = 0;
        return {
          ...actual,
          loadInstanceConfigReadOnly: (input?: string) => {
            calls += 1;
            if (calls === 2) {
              return { status: "invalid" as const, error: "forced invalid output" };
            }
            return actual.loadInstanceConfigReadOnly(input);
          },
        };
      });

      const { writeAutoUpdateFlag: mockedWrite } = await import("../../src/auto-update-config.js");
      const result = mockedWrite(path, false);

      expect(result).toEqual({
        ok: false,
        reason: "invalid_output",
        message: expect.any(String),
      });
      const remaining = await readdir(join(path, ".."));
      expect(remaining.some((name) => name.includes(".tmp."))).toBe(false);
      // Original file untouched.
      const text = await readFile(path, "utf8");
      expect(text).toBe("autoUpdate: true\nprojects: {}\n");
    });
  });
});

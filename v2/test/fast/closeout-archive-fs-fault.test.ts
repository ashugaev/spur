// Faked node:fs readdirSync result: a Dirent whose is*() are all false (DT_UNKNOWN), which this
// host's filesystem cannot produce on demand. Matched by directory name; other calls pass through.
import type * as NodeFs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCloseoutArchive } from "../../src/closeout-archive.js";

const FAULT_DIR = "fault-root";

function unknownDirent(name: string): NodeFs.Dirent {
  return {
    name,
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as NodeFs.Dirent;
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readdirSync: ((...args: unknown[]) => {
      const path = args[0];
      if (typeof path === "string" && path.endsWith(FAULT_DIR)) {
        return ["real.txt", "link.txt", "gone.txt"].map(unknownDirent);
      }
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof NodeFs.readdirSync,
  };
});

let base = "";

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("closeout archive with unknown dirent types", () => {
  it("classifies via lstat: file copied, symlink dropped, vanished entry unreadable", async () => {
    base = mkdtempSync(join(tmpdir(), "closeout-fault-"));
    const root = join(base, FAULT_DIR);
    mkdirSync(root);
    writeFileSync(join(root, "real.txt"), "data");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    const sessionDir = join(base, "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    const manifest = await writeCloseoutArchive({
      sessionDir,
      sessionId: "s1",
      project: "p",
      completedAt: "2026-01-01T00:00:00.000Z",
      links: [],
      snapshotVersion: null,
      headSha: null,
      roots: { artifacts: root, work: null, workspace: null },
      include: ["artifacts:**"],
      maxBytes: 1000,
    });
    expect(manifest.files.map((f) => f.path)).toEqual(["real.txt"]);
    expect(manifest.skipped).toEqual([
      { root: "artifacts", path: "gone.txt", bytes: 0, reason: "unreadable" },
    ]);
  });
});

// Pins two review-flagged robustness gaps in the nested artifact walk
// (v2/src/session-artifacts.ts), both amendments recorded in
// $SPUR_SESSION_ARTIFACTS_DIR/spec.md Amendments:
//
// 1. A throw from Dir#readSync() (or #closeSync()) below the root must skip that one
//    directory, not escape listSessionArtifacts and 500 the session route.
// 2. A dirent whose isFile()/isDirectory()/isSymbolicLink() all return false (Node's mapping
//    of DT_UNKNOWN, seen on XFS without ftype and some FUSE/NFS mounts) must still be listed
//    via an lstatSync fallback, not silently dropped.
//
// Both require faking node:fs return values that the real filesystem on this host cannot
// produce on demand, hence the module mock below (matched only by directory/entry name so
// unrelated real-fs calls in these tests pass through unchanged).
import type * as NodeFs from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const FAULT_DIR_NAME = "fault-dir";
const UNKNOWN_ENTRY_NAME = "mystery.dat";
const NESTED_UNKNOWN_DIR_NAME = "nested-unknown-dir";

function fakeDirent(name: string, isFile: boolean): NodeFs.Dirent {
  return {
    name,
    isFile: () => isFile,
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
    opendirSync: ((...args: unknown[]) => {
      const path = args[0];
      if (typeof path === "string" && path.endsWith(FAULT_DIR_NAME)) {
        return {
          readSync: () => {
            throw new Error("simulated EIO on readSync");
          },
          closeSync: () => {
            // no-op: the real directory handle was never opened for this fake Dir.
          },
        } as unknown as NodeFs.Dir;
      }
      if (typeof path === "string" && path.endsWith(NESTED_UNKNOWN_DIR_NAME)) {
        // Simulates a nested directory whose entries come back over
        // opendirSync/readSync (the walk's below-root path) rather than readdirSync (the
        // root path above), including one DT_UNKNOWN dirent among them.
        const dirents = [
          fakeDirent("keep-nested.txt", true),
          fakeDirent(UNKNOWN_ENTRY_NAME, false),
        ];
        let cursor = 0;
        return {
          readSync: () => (cursor < dirents.length ? dirents[cursor++] : null),
          closeSync: () => {
            // no-op: the real directory handle was never opened for this fake Dir.
          },
        } as unknown as NodeFs.Dir;
      }
      return (actual.opendirSync as (...fnArgs: unknown[]) => unknown)(...args);
    }) as unknown as typeof actual.opendirSync,
    readdirSync: ((...args: unknown[]) => {
      const result = (actual.readdirSync as (...fnArgs: unknown[]) => unknown)(...args) as unknown;
      if (!Array.isArray(result)) {
        return result;
      }
      return result.map((entry: unknown) => {
        const dirent = entry as NodeFs.Dirent;
        if (dirent?.name !== UNKNOWN_ENTRY_NAME) {
          return dirent;
        }
        // Simulates a DT_UNKNOWN dirent: every type predicate reports false, exactly what
        // Node produces for UV_DIRENT_UNKNOWN.
        return {
          name: dirent.name,
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isSocket: () => false,
        } as unknown as NodeFs.Dirent;
      });
    }) as unknown as typeof actual.readdirSync,
  };
});

const { listSessionArtifacts, sessionArtifactsDir } =
  await import("../../src/session-artifacts.js");
const { createTempDir } = await import("../helpers/common.js");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDataDir(): Promise<string> {
  const dir = await createTempDir("spur-artifacts-fault-");
  tempDirs.push(dir);
  return dir;
}

describe("listSessionArtifacts fs fault handling", () => {
  it("skips a directory whose readSync throws and still returns the other artifacts", async () => {
    const dataDir = await newDataDir();
    const sessionId = "fault-readsync";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(join(dir, "good"), { recursive: true });
    await mkdir(join(dir, FAULT_DIR_NAME), { recursive: true });
    await writeFile(join(dir, "good", "keep.txt"), "hi", "utf8");
    await writeFile(join(dir, "root.txt"), "hi", "utf8");

    const { artifacts } = listSessionArtifacts(dataDir, sessionId);

    const ids = artifacts.map((artifact) => artifact.id);
    expect(ids).toContain("root.txt");
    expect(ids).toContain("good/keep.txt");
  });

  it("lists a dirent whose type predicates all report false via an lstatSync fallback", async () => {
    const dataDir = await newDataDir();
    const sessionId = "fault-unknown-dirent";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "keep.txt"), "hi", "utf8");
    await writeFile(join(dir, UNKNOWN_ENTRY_NAME), "hi", "utf8");

    const { artifacts } = listSessionArtifacts(dataDir, sessionId);

    const ids = artifacts.map((artifact) => artifact.id);
    expect(ids).toContain("keep.txt");
    expect(ids).toContain(UNKNOWN_ENTRY_NAME);
  });

  it("lists a nested dirent whose type predicates all report false via an lstatSync fallback", async () => {
    const dataDir = await newDataDir();
    const sessionId = "fault-unknown-nested-dirent";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    const nestedDir = join(dir, NESTED_UNKNOWN_DIR_NAME);
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "keep-nested.txt"), "hi", "utf8");
    await writeFile(join(nestedDir, UNKNOWN_ENTRY_NAME), "hi", "utf8");

    const { artifacts } = listSessionArtifacts(dataDir, sessionId);

    const ids = artifacts.map((artifact) => artifact.id);
    expect(ids).toContain(`${NESTED_UNKNOWN_DIR_NAME}/keep-nested.txt`);
    expect(ids).toContain(`${NESTED_UNKNOWN_DIR_NAME}/${UNKNOWN_ENTRY_NAME}`);
  });
});

import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/types.js";
import type { InstanceConfigReadResult } from "../../src/config.js";
import type * as ProcessTreeModule from "../../src/process-tree.js";

const snapshotProcessesMock = vi.fn();

vi.mock("../../src/process-tree.js", async () => {
  const actual = await vi.importActual<typeof ProcessTreeModule>("../../src/process-tree.js");
  return { ...actual, snapshotProcesses: snapshotProcessesMock };
});

const { createDiskGcDeps } = await import("../../src/disk-gc.js");

function fakeConfig(worktreeDir: string): AppConfig {
  return { worktreeDir, dataDir: worktreeDir } as unknown as AppConfig;
}

const instanceConfig = {
  status: "ok",
  config: {},
} as unknown as Extract<InstanceConfigReadResult, { status: "ok" }>;

describe("createDiskGcDeps — profileDeleteGuard execute-time re-check", () => {
  let profileDir: string;

  afterEach(async () => {
    snapshotProcessesMock.mockReset();
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
  });

  it("fails closed when the process list is unreadable (real defect: was fail-open)", async () => {
    profileDir = await mkdtemp(join(tmpdir(), "spur-profile-guard-"));
    snapshotProcessesMock.mockResolvedValue({ status: "unavailable" });

    const deps = await createDiskGcDeps(fakeConfig(tmpdir()), instanceConfig);
    const result = await deps.profileDeleteGuard(profileDir);

    expect(result).toBe("process_list_unreadable");
  });

  it("fails closed when the process list is readable but empty", async () => {
    profileDir = await mkdtemp(join(tmpdir(), "spur-profile-guard-"));
    snapshotProcessesMock.mockResolvedValue({ status: "ok", processes: [] });

    const deps = await createDiskGcDeps(fakeConfig(tmpdir()), instanceConfig);
    const result = await deps.profileDeleteGuard(profileDir);

    expect(result).toBe("process_list_unreadable");
  });

  it("refuses a profile dir that is a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-profile-guard-"));
    const real = join(root, "real");
    profileDir = join(root, "mcp-x");
    await mkdir(real, { recursive: true });
    await symlink(real, profileDir);
    snapshotProcessesMock.mockResolvedValue({
      status: "ok",
      processes: [{ pid: 1, args: "init" }],
    });

    const deps = await createDiskGcDeps(fakeConfig(tmpdir()), instanceConfig);
    const result = await deps.profileDeleteGuard(profileDir);

    expect(result).toBe("symlink");
    profileDir = root;
  });

  it("allows deletion when the process list is readable, non-empty, and no match", async () => {
    profileDir = await mkdtemp(join(tmpdir(), "spur-profile-guard-"));
    snapshotProcessesMock.mockResolvedValue({
      status: "ok",
      processes: [{ pid: 1, args: "init" }],
    });

    const deps = await createDiskGcDeps(fakeConfig(tmpdir()), instanceConfig);
    const result = await deps.profileDeleteGuard(profileDir);

    expect(result).toBeNull();
  });
});

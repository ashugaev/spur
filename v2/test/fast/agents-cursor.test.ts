import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

vi.mock("../../src/agents/worktree-path.js", () => ({
  resolveWorktreePathCandidates: vi.fn(),
}));

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { resolveWorktreePathCandidates } from "../../src/agents/worktree-path.js";
import {
  buildCursorPlan,
  buildCursorRestorePlan,
  buildCursorResumePlan,
  cursorCommand,
  cursorConfigDirForSession,
  ensureCursorRestrictWritesConfig,
  ensureCursorWorkspaceTrust,
  findCursorSessionId,
} from "../../src/agents/cursor.js";

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
const mockReaddir = readdir as ReturnType<typeof vi.fn>;
const mockStat = stat as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockRename = rename as ReturnType<typeof vi.fn>;
const mockChmod = chmod as ReturnType<typeof vi.fn>;
const mockResolveWorktreePathCandidates = resolveWorktreePathCandidates as ReturnType<typeof vi.fn>;

function cursorHash(path: string): string {
  return createHash("md5").update(resolve(path)).digest("hex");
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["SPUR_CURSOR_BIN"];
  delete process.env["CURSOR_CONFIG_DIR"];
});

afterEach(() => {
  delete process.env["SPUR_CURSOR_BIN"];
  delete process.env["CURSOR_CONFIG_DIR"];
});

describe("cursorCommand", () => {
  it("returns agent by default", () => {
    expect(cursorCommand()).toBe("agent");
  });

  it("returns SPUR_CURSOR_BIN when set", () => {
    process.env["SPUR_CURSOR_BIN"] = "/custom/cursor-agent";
    expect(cursorCommand()).toBe("/custom/cursor-agent");
  });
});

describe("cursorConfigDirForSession", () => {
  it("stores Cursor state under the Spur data dir", () => {
    expect(cursorConfigDirForSession("/tmp/spur-data", "api-1")).toBe(
      "/tmp/spur-data/cursor/api-1",
    );
  });
});

describe("buildCursorPlan", () => {
  it("returns the default launch plan", () => {
    const plan = buildCursorPlan("ship it");
    expect(plan.launchCommand).toBe("agent --force --sandbox disabled --model 'auto'");
    expect(plan.initialMessage).toBe("ship it");
    expect(plan.readyMarkers).toEqual(["Cursor Agent", "Composer"]);
  });

  it("adds --plan when requested", () => {
    const plan = buildCursorPlan("ship it", { planMode: true });
    expect(plan.launchCommand).toBe("agent --force --sandbox disabled --plan --model 'auto'");
  });

  it("adds --model when provided", () => {
    const plan = buildCursorPlan("ship it", { model: "composer-2.5-fast" });
    expect(plan.launchCommand).toBe("agent --force --sandbox disabled --model 'composer-2.5-fast'");
  });
});

describe("buildCursorResumePlan", () => {
  it("quotes the binary and chat id", () => {
    const plan = buildCursorResumePlan("chat-123", "/opt/cursor agent");
    expect(plan.launchCommand).toBe(
      "'/opt/cursor agent' --resume 'chat-123' --force --sandbox disabled",
    );
    expect(plan.readyMarkers).toEqual(["Add a follow-up"]);
  });

  it("adds --plan when requested", () => {
    const plan = buildCursorResumePlan("chat-123", "agent", { planMode: true });
    expect(plan.launchCommand).toContain("--plan");
  });

  it("does not add --model", () => {
    const plan = buildCursorResumePlan("chat-123", "agent");
    expect(plan.launchCommand).not.toContain("--model");
  });

  it("always includes --force --sandbox disabled", () => {
    const plan = buildCursorResumePlan("chat-123", "agent");
    expect(plan.launchCommand).toContain("--force --sandbox disabled");
  });
});

describe("findCursorSessionId", () => {
  it("returns the newest chat across worktree path candidates", async () => {
    const primaryPath = "/worktree/path";
    const canonicalPath = "/canonical/worktree/path";
    const primaryHash = cursorHash(primaryPath);
    const canonicalHash = cursorHash(canonicalPath);
    mockResolveWorktreePathCandidates.mockResolvedValue([primaryPath, canonicalPath]);
    mockReaddir.mockImplementation(async (dir: unknown) => {
      if (dir === `/home/testuser/.cursor/chats/${primaryHash}`) {
        return ["chat-old"];
      }
      if (dir === `/home/testuser/.cursor/chats/${canonicalHash}`) {
        return ["chat-new"];
      }
      return [];
    });
    mockStat.mockImplementation(async (path: unknown) => {
      if (typeof path === "string" && path.endsWith("/chat-old/store.db")) {
        return { mtimeMs: 1_000 };
      }
      if (typeof path === "string" && path.endsWith("/chat-new/store.db")) {
        return { mtimeMs: 2_000 };
      }
      throw new Error(`unexpected stat path: ${String(path)}`);
    });

    await expect(findCursorSessionId(primaryPath)).resolves.toBe("chat-new");
    expect(mockReaddir).toHaveBeenCalledWith(`/home/testuser/.cursor/chats/${primaryHash}`);
    expect(mockReaddir).toHaveBeenCalledWith(`/home/testuser/.cursor/chats/${canonicalHash}`);
  });

  it("returns null when no chat store exists", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue([]);

    await expect(findCursorSessionId("/worktree/path")).resolves.toBeNull();
  });

  it("reads chats from an explicit config dir when provided", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue(["chat-explicit"]);
    mockStat.mockResolvedValue({ mtimeMs: 3_000 });

    await expect(
      findCursorSessionId("/worktree/path", { configDir: "/tmp/spur-data/cursor/api-1" }),
    ).resolves.toBe("chat-explicit");
    expect(mockReaddir).toHaveBeenCalledWith(
      `/tmp/spur-data/cursor/api-1/chats/${cursorHash("/worktree/path")}`,
    );
  });
});

describe("ensureCursorRestrictWritesConfig", () => {
  const worktreePath = "/repo/worktree";
  const cursorConfigDir = "/tmp/spur-data/cursor/api-1";
  const scriptPath = `${cursorConfigDir}/restrict-writes-hook.js`;
  const hooksPath = `${worktreePath}/.cursor/hooks.json`;

  beforeEach(() => {
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(false);
  });

  it("writes deny Write permissions into cli-config.json", async () => {
    await ensureCursorRestrictWritesConfig(worktreePath, cursorConfigDir);

    const content = JSON.parse(mockWriteFile.mock.calls[0]?.[1] as string) as {
      permissions: { deny: string[] };
    };
    expect(content.permissions.deny).toEqual(["Write(**)"]);
  });

  it("materializes the guard script with mode 0o755", async () => {
    await ensureCursorRestrictWritesConfig(worktreePath, cursorConfigDir);

    const scriptWriteCall = mockWriteFile.mock.calls.find((call) => call[0] === scriptPath);
    expect(scriptWriteCall).toBeDefined();
    expect(scriptWriteCall?.[1]).toContain("#!/usr/bin/env node");
    expect(mockChmod).toHaveBeenCalledWith(scriptPath, 0o755);
  });

  it("merges a beforeShellExecution entry with an absolute script path and failClosed", async () => {
    mockExistsSync.mockImplementation((path: unknown) => path === hooksPath);
    mockReadFile.mockResolvedValue(JSON.stringify({ version: 1, hooks: { stop: ["build.sh"] } }));

    await ensureCursorRestrictWritesConfig(worktreePath, cursorConfigDir);

    expect(mockRename).toHaveBeenCalled();
    const [tmpPath, destPath] = mockRename.mock.calls[0] as [string, string];
    expect(tmpPath).not.toBe(hooksPath);
    expect(destPath).toBe(hooksPath);
    const written = mockWriteFile.mock.calls.find((call) => call[0] === tmpPath);
    expect(written).toBeDefined();
    const merged = JSON.parse(written?.[1] as string) as {
      hooks: { stop: string[]; beforeShellExecution: Array<Record<string, unknown>> };
    };
    expect(merged.hooks.stop).toEqual(["build.sh"]);
    expect(merged.hooks.beforeShellExecution).toEqual([
      { command: scriptPath, timeout: 5, failClosed: true },
    ]);
  });

  it("does not duplicate the entry on re-invocation", async () => {
    let hooksJson = JSON.stringify({ version: 1, hooks: {} });
    mockExistsSync.mockImplementation((path: unknown) => path === hooksPath);
    mockReadFile.mockImplementation(async () => hooksJson);
    mockRename.mockImplementation(async (from: string) => {
      const written = mockWriteFile.mock.calls.find((call) => call[0] === from);
      hooksJson = written?.[1] as string;
    });

    await ensureCursorRestrictWritesConfig(worktreePath, cursorConfigDir);
    await ensureCursorRestrictWritesConfig(worktreePath, cursorConfigDir);

    const merged = JSON.parse(hooksJson) as {
      hooks: { beforeShellExecution: Array<Record<string, unknown>> };
    };
    expect(merged.hooks.beforeShellExecution).toHaveLength(1);
  });

  it("preserves an existing stop array untouched", async () => {
    mockExistsSync.mockImplementation((path: unknown) => path === hooksPath);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, hooks: { stop: ["build.sh", "auto-push.sh"] } }),
    );

    await ensureCursorRestrictWritesConfig(worktreePath, cursorConfigDir);

    const tmpPath = mockRename.mock.calls[0]?.[0] as string;
    const written = mockWriteFile.mock.calls.find((call) => call[0] === tmpPath);
    const merged = JSON.parse(written?.[1] as string) as { hooks: { stop: string[] } };
    expect(merged.hooks.stop).toEqual(["build.sh", "auto-push.sh"]);
  });

  it("throws instead of clobbering an unparseable existing hooks.json", async () => {
    mockExistsSync.mockImplementation((path: unknown) => path === hooksPath);
    mockReadFile.mockResolvedValue("{not valid json");

    await expect(ensureCursorRestrictWritesConfig(worktreePath, cursorConfigDir)).rejects.toThrow();
    expect(mockRename).not.toHaveBeenCalled();
  });
});

describe("buildCursorRestorePlan", () => {
  it("returns null when no chat can be found", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue([]);

    await expect(buildCursorRestorePlan("/worktree/path", "restore prompt")).resolves.toBeNull();
  });

  it("returns a resume plan with the original prompt when a chat exists", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue(["chat-123"]);
    mockStat.mockResolvedValue({ mtimeMs: 1_000 });

    const plan = await buildCursorRestorePlan("/worktree/path", "restore prompt");

    expect(plan).not.toBeNull();
    expect(plan?.launchCommand).toBe("'agent' --resume 'chat-123' --force --sandbox disabled");
    expect(plan?.initialMessage).toBe("restore prompt");
    expect(plan?.readyMarkers).toEqual(["Add a follow-up"]);
  });

  it("uses an explicit Cursor config dir when restoring", async () => {
    mockResolveWorktreePathCandidates.mockResolvedValue(["/worktree/path"]);
    mockReaddir.mockResolvedValue(["chat-123"]);
    mockStat.mockResolvedValue({ mtimeMs: 1_000 });

    await buildCursorRestorePlan("/worktree/path", "restore prompt", {
      cursorConfigDir: "/tmp/spur-data/cursor/api-1",
    });

    expect(mockReaddir).toHaveBeenCalledWith(
      `/tmp/spur-data/cursor/api-1/chats/${cursorHash("/worktree/path")}`,
    );
  });
});

describe("ensureCursorWorkspaceTrust", () => {
  it("writes the Cursor trust marker when missing", async () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    await ensureCursorWorkspaceTrust("/repo/worktree");

    expect(mockMkdir).toHaveBeenCalledWith("/repo/worktree/.cursor", { recursive: true });
    const writeCall = mockWriteFile.mock.calls[0];
    expect(writeCall?.[0]).toBe("/repo/worktree/.cursor/.workspace-trusted");
    expect(writeCall?.[2]).toBe("utf8");
    const payload = JSON.parse((writeCall?.[1] as string).trim()) as {
      trustMethod: string;
      workspacePath: string;
      trustedAt: string;
    };
    expect(payload.trustMethod).toBe("spur");
    expect(payload.workspacePath).toBe("/repo/worktree");
    expect(payload.trustedAt).toBeTypeOf("string");
  });

  it("skips writes when the trust marker already exists", async () => {
    mockExistsSync.mockReturnValue(true);

    await ensureCursorWorkspaceTrust("/repo/worktree");

    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

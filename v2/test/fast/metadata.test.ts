import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSession, writeSession } from "../../src/metadata.js";
import type { SessionRecord } from "../../src/types.js";

const tempDirs: string[] = [];

async function createDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spur-metadata-"));
  tempDirs.push(dir);
  return dir;
}

describe("metadata session persistence", () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) break;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves planMode when writing and reading a session record", async () => {
    const dataDir = await createDataDir();
    const session: SessionRecord = {
      id: "api-1",
      project: "api",
      agent: "cursor",
      planMode: true,
      prompt: "ship it",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "agent --force --sandbox disabled --plan",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };

    writeSession(dataDir, session);

    expect(readSession(dataDir, "api-1")).toEqual(expect.objectContaining({ planMode: true }));
  });
});

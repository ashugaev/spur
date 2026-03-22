import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendStatusInstructions, ensureStatusCommand } from "../../src/agent-status.js";
import { createTempDir, execFileAsync } from "../helpers/common.js";

const cleanupRoots: string[] = [];

function sessionRecord() {
  return {
    id: "api-1",
    project: "api",
    agent: "claude",
    prompt: "hello",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/worktree",
    tmuxSession: "api-1",
    launchCommand: "claude --dangerously-skip-permissions",
    status: "running",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
  };
}

async function setupStatusHelper() {
  const root = await createTempDir("spur-status-fast-");
  cleanupRoots.push(root);
  const dataDir = join(root, "data");
  const sessionPath = join(dataDir, "sessions", "api", "api-1.json");
  await mkdir(join(dataDir, "sessions", "api"), { recursive: true });
  await writeFile(sessionPath, JSON.stringify(sessionRecord(), null, 2) + "\n", "utf8");

  return {
    dataDir,
    sessionPath,
    commandPath: ensureStatusCommand(dataDir),
    env: {
      ...process.env,
      SPUR_DATA_DIR: dataDir,
      SPUR_PROJECT: "api",
      SPUR_SESSION: "api-1",
    },
  };
}

afterEach(async () => {
  while (cleanupRoots.length > 0) {
    await rm(cleanupRoots.pop() as string, { recursive: true, force: true });
  }
});

describe("agent-status helper", () => {
  it("updates session metadata to the requested status", async () => {
    const helper = await setupStatusHelper();

    const needsInput = await execFileAsync(helper.commandPath, ["needs_input"], {
      env: helper.env,
    });
    expect(needsInput.stdout.trim()).toBe("needs_input");

    const afterNeedsInput = JSON.parse(await readFile(helper.sessionPath, "utf8")) as {
      status: string;
    };
    expect(afterNeedsInput.status).toBe("needs_input");

    const done = await execFileAsync(helper.commandPath, ["done"], {
      env: helper.env,
    });
    expect(done.stdout.trim()).toBe("done");

    const afterDone = JSON.parse(await readFile(helper.sessionPath, "utf8")) as { status: string };
    expect(afterDone.status).toBe("done");
  });

  it("rejects unsupported statuses", async () => {
    const helper = await setupStatusHelper();

    await expect(
      execFileAsync(helper.commandPath, ["bogus"], {
        env: helper.env,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Usage: spur-status <running|needs_input|done>"),
    });
  });

  it("does not duplicate prompt instructions", () => {
    const prompt = `hello

Spur session status:
- When you need human input, run: "$SPUR_STATUS_COMMAND" needs_input`;

    expect(appendStatusInstructions(prompt)).toBe(prompt);
  });
});

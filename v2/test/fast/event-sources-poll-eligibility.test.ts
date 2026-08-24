import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEligibleForSourcePoll } from "../../src/event-sources/types.js";

describe("isEligibleForSourcePoll", () => {
  const projectId = "acme";
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkdtempSync(join(tmpdir(), "spur-poll-eligibility-"));
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it("accepts a running session in the project with a live worktree", () => {
    expect(
      isEligibleForSourcePoll({ project: projectId, status: "running", worktreePath }, projectId),
    ).toBe(true);
  });

  it("accepts a stale-parked session", () => {
    expect(
      isEligibleForSourcePoll(
        { project: projectId, status: "stopped", stopReason: "stale_timeout", worktreePath },
        projectId,
      ),
    ).toBe(true);
  });

  it("rejects a session from a different project", () => {
    expect(
      isEligibleForSourcePoll({ project: "other", status: "running", worktreePath }, projectId),
    ).toBe(false);
  });

  it("rejects a session that is neither running nor stale-parked", () => {
    expect(
      isEligibleForSourcePoll(
        { project: projectId, status: "stopped", stopReason: "manual_pause", worktreePath },
        projectId,
      ),
    ).toBe(false);
  });

  it("rejects a session whose worktree no longer exists on disk", () => {
    expect(
      isEligibleForSourcePoll(
        {
          project: projectId,
          status: "running",
          worktreePath: join(worktreePath, "gone"),
        },
        projectId,
      ),
    ).toBe(false);
  });
});

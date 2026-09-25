// A3: the only real-disk test for the durable poll-disabled registry. metadata.ts
// and node:fs are both UNMOCKED — isEligibleForSourcePoll (event-sources/types.ts:97-107)
// calls the real existsSync on session.worktreePath, so this file must create a real
// worktree directory and write a real session record, or every session here is
// silently filtered out and every assertion below holds vacuously (see the positive
// control in case 1).
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ghModule from "../../src/gh.js";
import type { SessionRecord } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const ghTransportMock = vi.fn();
const logSpurEventMock = vi.fn();

vi.mock("../../src/gh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ghModule>()),
  gh: ghTransportMock,
}));
vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));

const { githubSourceModule } = await import("../../src/event-sources/github.js");
const { writeSession, recordGitHubPollDisabledSession } = await import("../../src/metadata.js");
const { rmSync, existsSync } = await import("node:fs");

const flushPollCycle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDataDir(): Promise<string> {
  const dir = await createTempDir("spur-poll-disabled-restart-");
  tempDirs.push(dir);
  return dir;
}

// gh call order for a bound-PR lifecycle poll (see review-providers/github.ts's
// GraphQL batch query): a single alias `a0` carrying the whole PR node.
function openPrEnvelope(prNumber: number): string {
  return JSON.stringify({
    data: {
      rateLimit: { cost: 1, remaining: 4_800, resetAt: "2026-06-19T11:00:00.000Z" },
      r: {
        a0: {
          number: prNumber,
          title: "Fix CI alert",
          url: `https://github.com/acme/api/pull/${prNumber}`,
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          commits: {
            nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }],
          },
          reviewThreads: { nodes: [] },
          comments: { nodes: [] },
          reviews: { nodes: [] },
        },
      },
    },
  });
}

async function makeSession(dataDir: string, worktreePath: string): Promise<SessionRecord> {
  await mkdir(worktreePath, { recursive: true });
  const session: SessionRecord = {
    id: "api-a1b2",
    project: "api",
    workspaceId: "api-a1b2",
    agent: "claude",
    prompt: "fix the bug",
    branch: "feature/native-pr-binding",
    pr: { number: 42, repo: "acme/api", url: "https://github.com/acme/api/pull/42" },
    worktree: true,
    worktreePath,
    tmuxSession: "api-a1b2",
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-04-26T09:00:00.000Z",
    updatedAt: "2026-04-26T09:00:00.000Z",
  };
  writeSession(dataDir, session);
  return session;
}

async function startHandle(dataDir: string) {
  return githubSourceModule.start({
    sourceId: "pr-watch",
    projectId: "api",
    dataDir,
    config: { type: "github", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
    emit: vi.fn(),
    signal: new AbortController().signal,
    logger: { info: vi.fn(), warn: vi.fn() },
    resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
  });
}

describe("github poll-disabled registry survives a real restart", () => {
  it("case 1 (positive control): the fixture reaches the poll path at all", async () => {
    const dataDir = await newDataDir();
    await makeSession(dataDir, join(dataDir, "worktree-1"));
    ghTransportMock.mockResolvedValue(openPrEnvelope(42));

    const handle = await startHandle(dataDir);
    handle.runOnStart?.();
    await flushPollCycle();

    expect(ghTransportMock).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it("case 2: a registry entry recorded before a fresh handle start survives it", async () => {
    const dataDir = await newDataDir();
    await makeSession(dataDir, join(dataDir, "worktree-2"));
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2", 42);
    ghTransportMock.mockResolvedValue(openPrEnvelope(42));

    const handle = await startHandle(dataDir);
    handle.runOnStart?.();
    await flushPollCycle();

    expect(ghTransportMock).toHaveBeenCalledTimes(0);
    const disabledEvents = logSpurEventMock.mock.calls
      .map(([, entry]) => entry as { event?: string })
      .filter((entry) => entry.event === "source.poll.disabled");
    expect(disabledEvents).toHaveLength(0);

    handle.stop();
  });

  it("case 3 (mutation check): removing the registry file re-arms polling", async () => {
    const dataDir = await newDataDir();
    await makeSession(dataDir, join(dataDir, "worktree-3"));
    recordGitHubPollDisabledSession(dataDir, "api", "pr-watch", "api-a1b2", 42);
    ghTransportMock.mockResolvedValue(openPrEnvelope(42));

    const registryPath = join(
      dataDir,
      "source-state",
      "github-poll-disabled",
      "api",
      "pr-watch.json",
    );
    expect(existsSync(registryPath)).toBe(true);
    rmSync(registryPath, { force: true });

    const handle = await startHandle(dataDir);
    handle.runOnStart?.();
    await flushPollCycle();

    expect(ghTransportMock).toHaveBeenCalledTimes(1);

    handle.stop();
  });
});

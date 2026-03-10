import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorConfig } from "@composio/ao-core";

const { mockedBaseDirRef } = vi.hoisted(() => ({ mockedBaseDirRef: { current: "" } }));

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    getProjectBaseDir: () => mockedBaseDirRef.current,
  };
});

import {
  createIntegrationHealthReporter,
  type IntegrationHealthSnapshot,
} from "../../src/lib/integration-health.js";

function makeConfig(configPath: string): OrchestratorConfig {
  return {
    configPath,
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      int: {
        name: "Int",
        repo: "org/int",
        path: join(configPath, "..", "repo"),
        defaultBranch: "main",
        sessionPrefix: "int",
        tracker: { plugin: "jira" },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  };
}

describe("integration health reporter", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ao-health-${randomUUID()}`);
    mockedBaseDirRef.current = join(rootDir, "ao-base");
    mkdirSync(mockedBaseDirRef.current, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("writes snapshot entries with expected shape and transitions", () => {
    const configPath = join(rootDir, "agent-orchestrator.yaml");
    const config = makeConfig(configPath);

    const reporter = createIntegrationHealthReporter({
      config,
      projectId: "int",
      project: config.projects.int!,
    });

    const identity = {
      id: "jira-comment-polling",
      label: "Jira Comment Polling",
      service: "jira" as const,
      kind: "polling" as const,
    };

    reporter.markStarting(identity, "Starting runtime");
    reporter.markHealthy(identity, "Cycle completed");
    reporter.markDegraded(identity, "Cycle failed", new Error("boom"));
    reporter.markInactive(identity, "Stopped");

    expect(existsSync(reporter.snapshotPath)).toBe(true);

    const parsed = JSON.parse(
      readFileSync(reporter.snapshotPath, "utf-8"),
    ) as IntegrationHealthSnapshot;

    expect(parsed.version).toBe(1);
    expect(parsed.projectId).toBe("int");
    expect(parsed.entries).toHaveLength(1);

    const [entry] = parsed.entries;
    expect(entry).toMatchObject({
      id: "jira-comment-polling",
      label: "Jira Comment Polling",
      service: "jira",
      kind: "polling",
      state: "inactive",
      active: false,
      connected: false,
      ok: false,
      message: "Stopped",
    });
    expect(entry.updatedAt).toBeTypeOf("string");
    expect(entry.lastCheckAt).toBeTypeOf("string");
    expect(entry.lastSuccessAt).toBeTypeOf("string");
    expect(entry.lastErrorAt).toBeTypeOf("string");
    expect(entry.lastError).toContain("boom");
  });

  it("uses atomic writes without leaving temp files", () => {
    const config = makeConfig(join(rootDir, "agent-orchestrator.yaml"));
    const reporter = createIntegrationHealthReporter({
      config,
      projectId: "int",
      project: config.projects.int!,
    });

    reporter.markHealthy(
      {
        id: "telegram-polling",
        label: "Telegram Inbound Polling",
        service: "telegram",
        kind: "polling",
      },
      "Healthy",
    );

    const files = readdirSync(mockedBaseDirRef.current);
    expect(files).toContain("integration-health.json");
    expect(files.some((name) => name.includes(".tmp."))).toBe(false);
  });

  it("keeps independent entries sorted by id", () => {
    const config = makeConfig(join(rootDir, "agent-orchestrator.yaml"));
    const reporter = createIntegrationHealthReporter({
      config,
      projectId: "int",
      project: config.projects.int!,
    });

    reporter.markHealthy(
      {
        id: "listener:tracker-task",
        label: "Listener tracker-task",
        service: "tracker",
        kind: "listener",
      },
      "Listener healthy",
    );

    reporter.markHealthy(
      {
        id: "jira-comment-polling",
        label: "Jira Comment Polling",
        service: "jira",
        kind: "polling",
      },
      "Polling healthy",
    );

    const parsed = JSON.parse(
      readFileSync(reporter.snapshotPath, "utf-8"),
    ) as IntegrationHealthSnapshot;

    expect(parsed.entries.map((entry) => entry.id)).toEqual([
      "jira-comment-polling",
      "listener:tracker-task",
    ]);
  });
});

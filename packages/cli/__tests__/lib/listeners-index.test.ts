import { describe, expect, it, vi } from "vitest";
import type { OrchestratorConfig, SessionManager } from "@composio/ao-core";
import type { ListenerController, ListenerSource } from "../../src/lib/listeners/types.js";
import type { IntegrationHealthReporter } from "../../src/lib/integration-health.js";
import {
  getListenerSource,
  maybeStartConfiguredListeners,
  registerListenerSource,
  unregisterListenerSource,
} from "../../src/lib/listeners/index.js";

function makeSessionManagerStub(): SessionManager {
  return {
    list: vi.fn(),
    spawn: vi.fn(),
    get: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    send: vi.fn(),
  };
}

function makeConfig(): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
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
        path: "/tmp/int",
        defaultBranch: "main",
        sessionPrefix: "int",
        tracker: { plugin: "jira" },
      },
      web: {
        name: "Web",
        repo: "org/web",
        path: "/tmp/web",
        defaultBranch: "main",
        sessionPrefix: "web",
        tracker: { plugin: "jira" },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    listeners: {},
  };
}

function makeHealthReporterStub(): IntegrationHealthReporter {
  return {
    snapshotPath: "/tmp/ao-test/integration-health.json",
    upsert: vi.fn(),
    markStarting: vi.fn(),
    markHealthy: vi.fn(),
    markDegraded: vi.fn(),
    markInactive: vi.fn(),
    getSnapshot: vi.fn(),
  };
}

describe("listeners registry", () => {
  it("registers and resolves custom sources", () => {
    const sourceName = "test-source-registry";
    const source: ListenerSource = {
      source: sourceName,
      start: async () => ({ stop: vi.fn() }),
    };

    registerListenerSource(source);
    expect(getListenerSource(sourceName)).toBe(source);

    unregisterListenerSource(sourceName);
    expect(getListenerSource(sourceName)).toBeUndefined();
  });
});

describe("maybeStartConfiguredListeners", () => {
  it("starts only listeners for the selected project", async () => {
    const sourceName = "test-source-project-scope";
    const stopA = vi.fn();
    const start = vi
      .fn<ListenerSource["start"]>()
      .mockResolvedValueOnce({ stop: stopA } satisfies ListenerController);
    const source: ListenerSource = {
      source: sourceName,
      start,
    };
    registerListenerSource(source);
    const healthReporter = makeHealthReporterStub();

    const config = makeConfig();
    config.listeners = {
      "listener-int": {
        source: sourceName,
        projectId: "int",
        trigger: { type: "spawn-session" },
      },
      "listener-web": {
        source: sourceName,
        projectId: "web",
        trigger: { type: "spawn-session" },
      },
    };

    const controller = await maybeStartConfiguredListeners({
      config,
      sessionManager: makeSessionManagerStub(),
      projectId: "int",
      logger: { warn: vi.fn() },
      healthReporter,
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        listenerId: "listener-int",
        projectId: "int",
      }),
    );
    expect(controller?.activeListeners).toEqual(["listener-int"]);

    controller?.stop();
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(healthReporter.markStarting).toHaveBeenCalledWith(
      expect.objectContaining({ id: "listener:listener-int" }),
      expect.stringContaining("Starting"),
    );
    expect(healthReporter.markHealthy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "listener:listener-int" }),
      expect.stringContaining(`source "${sourceName}"`),
    );
    expect(healthReporter.markInactive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "listener:listener-int" }),
      expect.stringContaining("stopped"),
    );

    unregisterListenerSource(sourceName);
  });

  it("skips unknown listener source and warns", async () => {
    const warn = vi.fn();
    const healthReporter = makeHealthReporterStub();
    const config = makeConfig();
    config.listeners = {
      "listener-unknown-source": {
        source: "missing-source",
        projectId: "int",
      },
    };

    const controller = await maybeStartConfiguredListeners({
      config,
      sessionManager: makeSessionManagerStub(),
      projectId: "int",
      logger: { warn },
      healthReporter,
    });

    expect(controller).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown source "missing-source"'),
    );
    expect(healthReporter.markInactive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "listener:listener-unknown-source" }),
      expect.stringContaining("unsupported source"),
    );
  });

  it("namespaces per-project listener ids when they collide with existing ids", async () => {
    const sourceName = "test-source-collision";
    const start = vi
      .fn<ListenerSource["start"]>()
      .mockResolvedValue({ stop: vi.fn() } satisfies ListenerController);
    registerListenerSource({
      source: sourceName,
      start,
    });

    const warn = vi.fn();
    const config = makeConfig();
    config.listeners = {
      duplicate: {
        source: sourceName,
        projectId: "int",
      },
    };
    config.projects.web!.listeners = {
      duplicate: {
        source: sourceName,
      },
    };

    const controller = await maybeStartConfiguredListeners({
      config,
      sessionManager: makeSessionManagerStub(),
      logger: { warn },
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        listenerId: "duplicate",
        projectId: "int",
      }),
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        listenerId: "web:duplicate",
        projectId: "web",
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('using namespaced id "web:duplicate"'),
    );
    expect(controller?.activeListeners).toEqual(expect.arrayContaining(["duplicate", "web:duplicate"]));

    controller?.stop();
    unregisterListenerSource(sourceName);
  });

  it("skips listener with unknown project and warns", async () => {
    const sourceName = "test-source-unknown-project";
    registerListenerSource({
      source: sourceName,
      start: async () => ({ stop: vi.fn() }),
    });

    const warn = vi.fn();
    const healthReporter = makeHealthReporterStub();
    const config = makeConfig();
    config.listeners = {
      "listener-unknown-project": {
        source: sourceName,
        projectId: "does-not-exist",
      },
    };

    const controller = await maybeStartConfiguredListeners({
      config,
      sessionManager: makeSessionManagerStub(),
      logger: { warn },
      healthReporter,
    });

    expect(controller).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown project "does-not-exist"'),
    );
    expect(healthReporter.markInactive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "listener:listener-unknown-project" }),
      expect.stringContaining('unknown project "does-not-exist"'),
    );

    unregisterListenerSource(sourceName);
  });
});

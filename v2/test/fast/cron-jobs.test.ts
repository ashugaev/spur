import { createHash } from "node:crypto";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstanceConfigReadOnly, loadProjectConfig } from "../../src/config.js";
import {
  buildCronJobsView,
  readCronEventTail,
  readCronJobs,
  resolveCronOwnerFiles,
  UnknownCronProjectError,
} from "../../src/cron-jobs.js";
import { mergeProjects } from "../../src/registry.js";
import type { AppConfig, CronJobsResponse } from "../../src/types.js";
import { cleanupTrackedTempDirs, createTempDir } from "../helpers/common.js";

afterEach(cleanupTrackedTempDirs);

interface Fixture {
  root: string;
  dataDir: string;
  bootstrapPath: string;
  repo: string;
}

async function fixture(): Promise<Fixture> {
  const root = await createTempDir("spur-cron-jobs-");
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  await mkdir(repo);
  await mkdir(dataDir);
  return { root, dataDir, repo, bootstrapPath: join(root, "spur.yaml") };
}

function instanceYaml(f: Fixture, projects: string): string {
  return [
    "server:",
    "  host: 127.0.0.1",
    "  port: 43987",
    `dataDir: ${f.dataDir}`,
    `worktreeDir: ${join(f.root, "worktrees")}`,
    "projects:",
    projects,
  ].join("\n");
}

function demoProject(f: Fixture, extra: { schedule?: string; prompt?: string } = {}) {
  return [
    "  demo:",
    `    path: ${f.repo}`,
    "    sources:",
    "      nightly:",
    "        type: cron",
    `        schedule: "${extra.schedule ?? "0 3 * * *"}"`,
    "      chat:",
    "        type: telegram",
    "        token: secret-token-x",
    "        allowedUsers: [1]",
    "    triggers:",
    "      audit:",
    "        source: nightly",
    "        event: cron:tick",
    "        spawn:",
    `          prompt: "${extra.prompt ?? "audit sessions"}"`,
    "          agent: claude",
    "          model: opus",
    "          branch: feature/hidden-branch-x",
    "          overrides:",
    "            worktree: true",
    "          selfDestruct:",
    "            enabled: true",
    "            conditions: hidden-condition-x",
    "      chat-reply:",
    "        source: chat",
    "        event: telegram:message",
    "        spawn:",
    "          prompt: chat prompt hidden-x",
  ].join("\n");
}

function loadRunning(path: string): AppConfig {
  const result = loadInstanceConfigReadOnly(path);
  if (result.status !== "ok") throw new Error(`fixture config not ok: ${JSON.stringify(result)}`);
  return result.config;
}

async function view(
  f: Fixture,
  running: AppConfig,
  registryPaths: string[] = [],
  projectId?: string,
): Promise<CronJobsResponse> {
  return readCronJobs({
    config: running,
    bootstrapConfigPath: f.bootstrapPath,
    registryPaths,
    knownProjectIds: new Set(Object.keys(running.projects)),
    ...(projectId !== undefined ? { projectId } : {}),
  });
}

function tickLine(at: string, projectId: string, sourceId: string, eventName = "cron:tick") {
  return JSON.stringify({
    timestamp: at,
    event: "source.event.emitted",
    level: "info",
    projectId,
    sourceId,
    details: { eventName, type: "cron" },
  });
}

function actionLine(at: string, event: string, triggerId: string, extra: object = {}) {
  return JSON.stringify({
    timestamp: at,
    event,
    level: "info",
    projectId: "demo",
    sourceId: "nightly",
    triggerId,
    ...extra,
  });
}

describe("cron jobs view", () => {
  it("allow-list excludes overrides and source secrets", async () => {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const response = await view(f, loadRunning(f.bootstrapPath));
    const body = JSON.stringify(response);
    for (const hidden of [
      "secret-token-x",
      "hidden-branch-x",
      "hidden-condition-x",
      "chat prompt hidden-x",
      // Key forms: the owner path inside TMPDIR may contain these words.
      '"overrides":',
      '"selfDestruct":',
      '"worktree":',
      '"branch":',
      "chat-reply",
    ]) {
      expect(body).not.toContain(hidden);
    }
    expect(response.projects[0]?.sources).toEqual([
      {
        sourceId: "nightly",
        schedule: "0 3 * * *",
        runOnStart: false,
        disk: "same",
        recentTicks: [],
        triggers: [
          {
            triggerId: "audit",
            event: "cron:tick",
            disk: "same",
            action: {
              kind: "spawn",
              blocks: [
                {
                  prompt: "audit sessions",
                  agent: "claude",
                  model: "opus",
                  reasoningEffort: null,
                  mode: null,
                },
              ],
            },
            recentActions: [],
          },
        ],
      },
    ]);
  });

  it("lists a source without trigger, a send trigger and multi-block spawns in order", async () => {
    const f = await fixture();
    await writeFile(
      f.bootstrapPath,
      instanceYaml(
        f,
        [
          "  demo:",
          `    path: ${f.repo}`,
          "    name: Demo Project",
          "    sources:",
          "      lonely: {type: cron, schedule: '*/15 * * * *', runOnStart: true}",
          "      digest: {type: cron, schedule: '0 * * * *'}",
          "    triggers:",
          "      poke:",
          "        source: digest",
          "        event: cron:tick",
          "        send: {interrupt: false, prompt: hello}",
          "      pair:",
          "        source: digest",
          "        event: cron:tick",
          "        spawn:",
          "          - {prompt: first, agent: codex, reasoningEffort: high}",
          "          - {prompt: second, mode: manager}",
        ].join("\n"),
      ),
    );
    const response = await view(f, loadRunning(f.bootstrapPath));
    const project = response.projects[0];
    expect(project?.projectName).toBe("Demo Project");
    expect(project?.sources.map((source) => [source.sourceId, source.runOnStart])).toEqual([
      ["lonely", true],
      ["digest", false],
    ]);
    expect(project?.sources[0]?.triggers).toEqual([]);
    const triggers = project?.sources[1]?.triggers ?? [];
    expect(triggers.map((trigger) => trigger.triggerId)).toEqual(["poke", "pair"]);
    expect(triggers[0]?.action).toEqual({ kind: "send", prompt: "hello" });
    expect(triggers[1]?.action).toEqual({
      kind: "spawn",
      blocks: [
        { prompt: "first", agent: "codex", model: null, reasoningEffort: "high", mode: null },
        { prompt: "second", agent: null, model: null, reasoningEffort: null, mode: "manager" },
      ],
    });
  });

  it("omits projects without cron sources", async () => {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, `  plain:\n    path: ${f.repo}`));
    expect(await view(f, loadRunning(f.bootstrapPath))).toEqual({
      projects: [],
      eventsSince: null,
    });
  });

  it("reports owner revision as sha256 of the file bytes", async () => {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const response = await view(f, loadRunning(f.bootstrapPath));
    const bytes = await readFile(f.bootstrapPath);
    expect(response.projects[0]?.owner).toEqual({
      state: "loaded",
      path: f.bootstrapPath,
      revision: createHash("sha256").update(bytes).digest("hex"),
      changed: false,
    });
  });
});

describe("cron jobs drift", () => {
  async function drifted(edit: { schedule?: string; prompt?: string }) {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const running = loadRunning(f.bootstrapPath);
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f, edit)));
    return { f, response: await view(f, running) };
  }

  it("flags a changed schedule on the source and the project", async () => {
    const { response } = await drifted({ schedule: "0 4 * * *" });
    const project = response.projects[0];
    expect(project?.owner).toMatchObject({ state: "loaded", changed: true });
    expect(project?.sources[0]).toMatchObject({ schedule: "0 3 * * *", disk: "changed" });
    expect(project?.sources[0]?.triggers[0]?.disk).toBe("same");
  });

  it("flags a changed trigger prompt", async () => {
    const { response } = await drifted({ prompt: "new prompt" });
    const source = response.projects[0]?.sources[0];
    expect(source?.disk).toBe("same");
    expect(source?.triggers[0]).toMatchObject({ disk: "changed" });
    expect(source?.triggers[0]?.action).toMatchObject({
      blocks: [{ prompt: "audit sessions" }],
    });
  });

  it("marks added and removed sources and triggers", async () => {
    const f = await fixture();
    const project = (sources: string, triggers: string) =>
      instanceYaml(
        f,
        ["  demo:", `    path: ${f.repo}`, "    sources:", sources, "    triggers:", triggers].join(
          "\n",
        ),
      );
    await writeFile(
      f.bootstrapPath,
      project(
        "      old: {type: cron, schedule: '0 1 * * *'}",
        "      old-job: {source: old, event: 'cron:tick', spawn: {prompt: old}}",
      ),
    );
    const running = loadRunning(f.bootstrapPath);
    await writeFile(
      f.bootstrapPath,
      project(
        "      fresh: {type: cron, schedule: '0 2 * * *'}",
        "      fresh-job: {source: fresh, event: 'cron:tick', spawn: {prompt: fresh}}",
      ),
    );
    const response = await view(f, running);
    const sources = response.projects[0]?.sources ?? [];
    expect(sources.map((source) => [source.sourceId, source.disk, source.schedule])).toEqual([
      ["old", "removed", "0 1 * * *"],
      ["fresh", "added", "0 2 * * *"],
    ]);
    expect(sources[0]?.triggers.map((trigger) => [trigger.triggerId, trigger.disk])).toEqual([
      ["old-job", "removed"],
    ]);
    expect(sources[1]?.triggers.map((trigger) => [trigger.triggerId, trigger.disk])).toEqual([
      ["fresh-job", "added"],
    ]);
    expect(response.projects[0]?.owner).toMatchObject({ changed: true });
  });

  it("marks an invalid owner file with revision and error and every row unknown", async () => {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const running = loadRunning(f.bootstrapPath);
    await writeFile(
      f.bootstrapPath,
      instanceYaml(f, demoProject(f, { schedule: '0 3 * * *"\n        runOnStart: "maybe' })),
    );
    const bytes = await readFile(f.bootstrapPath);
    const response = await view(f, running);
    const project = response.projects[0];
    expect(project?.owner).toMatchObject({
      state: "invalid",
      path: f.bootstrapPath,
      revision: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(project?.owner.state === "invalid" ? project.owner.error : "").toContain("runOnStart");
    expect(project?.sources[0]?.disk).toBe("unknown");
    expect(project?.sources[0]?.triggers[0]?.disk).toBe("unknown");
  });

  it("reports an unparseable file as ambiguous, keeping only the parser message line", async () => {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const running = loadRunning(f.bootstrapPath);
    await writeFile(f.bootstrapPath, "projects: [unterminated-secret-x\n");
    const bytes = await readFile(f.bootstrapPath);
    expect(resolveCronOwnerFiles(f.bootstrapPath, [], running)).toEqual([
      {
        state: "parse_error",
        path: f.bootstrapPath,
        revision: createHash("sha256").update(bytes).digest("hex"),
        error: expect.stringMatching(/ at line \d+, column \d+$/) as unknown as string,
      },
    ]);
    const project = (await view(f, running)).projects[0];
    expect(project?.owner).toEqual({
      state: "ambiguous",
      failedFiles: [
        {
          file: "spur.yaml",
          reason: "parse_error",
          message: expect.stringMatching(/ at line \d+, column \d+$/) as unknown as string,
        },
      ],
    });
    expect(JSON.stringify(project)).not.toContain("unterminated-secret-x");
    expect(JSON.stringify(project)).not.toContain(f.root);
    expect(project?.sources[0]?.disk).toBe("unknown");
    expect(project?.sources[0]?.triggers[0]?.disk).toBe("unknown");
  });

  it("marks every loaded row removed when the owner file no longer declares the project", async () => {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const running = loadRunning(f.bootstrapPath);
    await writeFile(f.bootstrapPath, instanceYaml(f, `  plain:\n    path: ${f.repo}`));
    const project = (await view(f, running)).projects[0];
    expect(project?.owner).toEqual({ state: "project_removed" });
    expect(project?.sources[0]).toMatchObject({ sourceId: "nightly", disk: "removed" });
    expect(project?.sources[0]?.triggers[0]?.disk).toBe("removed");
  });
});

describe("cron jobs owner resolution", () => {
  async function withRegistry(registryYaml: (f: Fixture) => string) {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const registryPath = join(f.root, "side.yaml");
    await writeFile(registryPath, registryYaml(f));
    const base = loadRunning(f.bootstrapPath);
    const files = resolveCronOwnerFiles(f.bootstrapPath, [registryPath], base);
    return { f, base, registryPath, files };
  }

  it("registry file duplicating a project id owns nothing", async () => {
    const { f, base, registryPath, files } = await withRegistry(
      (f) =>
        `projects:\n  demo:\n    path: ${f.repo}\n    sessionPrefix: dup\n    sources: {nightly: {type: cron, schedule: '1 1 * * *'}}\n`,
    );
    expect(files.map((file) => [file.path, file.state])).toEqual([
      [f.bootstrapPath, "loaded"],
      [registryPath, "rejected"],
    ]);
    const response = buildCronJobsView({
      running: base,
      ownerFiles: files,
      events: [],
      eventsSince: null,
    });
    expect(response.projects[0]?.owner).toMatchObject({
      state: "loaded",
      path: f.bootstrapPath,
      changed: false,
    });
  });

  it("registry file with a colliding sessionPrefix owns nothing", async () => {
    const { base, registryPath, files } = await withRegistry(
      (f) =>
        `projects:\n  other:\n    path: ${f.repo}\n    sessionPrefix: demo\n    sources: {tick: {type: cron, schedule: '1 1 * * *'}}\n`,
    );
    expect(files.find((file) => file.path === registryPath)?.state).toBe("rejected");
    const response = buildCronJobsView({
      running: base,
      ownerFiles: files,
      events: [],
      eventsSince: null,
    });
    expect(response.projects.map((project) => project.projectId)).toEqual(["demo"]);
  });

  it("invalid bootstrap on disk does not invalidate a valid registry file", async () => {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const registryPath = join(f.root, "side.yaml");
    await writeFile(
      registryPath,
      `projects:\n  side:\n    path: ${f.repo}\n    sources: {hourly: {type: cron, schedule: '0 * * * *'}}\n`,
    );
    const base = loadRunning(f.bootstrapPath);
    const running = mergeProjects(base, [base, loadProjectConfig(registryPath, base)]);
    await writeFile(f.bootstrapPath, "server: [\n");
    const response = await view(f, running, [registryPath]);
    const side = response.projects.find((project) => project.projectId === "side");
    expect(side?.owner).toMatchObject({ state: "loaded", path: registryPath, changed: false });
    expect(side?.sources[0]?.disk).toBe("same");
    expect(response.projects.find((project) => project.projectId === "demo")?.owner).toMatchObject({
      state: "ambiguous",
      failedFiles: [{ file: "spur.yaml", reason: "parse_error" }],
    });
  });

  it("never attributes a project removed from a valid file to an unrelated broken file", async () => {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const registryPath = join(f.root, "side.yaml");
    await writeFile(
      registryPath,
      `projects:\n  side:\n    path: ${f.repo}\n    sources: {hourly: {type: cron, schedule: '0 * * * *'}}\n`,
    );
    const base = loadRunning(f.bootstrapPath);
    const running = mergeProjects(base, [base, loadProjectConfig(registryPath, base)]);
    await writeFile(f.bootstrapPath, instanceYaml(f, `  plain:\n    path: ${f.repo}`));
    await writeFile(registryPath, "projects: [\n");
    const response = await view(f, running, [registryPath]);
    const demo = response.projects.find((project) => project.projectId === "demo");
    // B is listed as a failed file only, never as the owner.
    expect(demo?.owner).toMatchObject({
      state: "ambiguous",
      failedFiles: [{ file: "side.yaml", reason: "parse_error" }],
    });
    expect(demo?.owner).not.toHaveProperty("path");
    expect(demo?.sources[0]?.disk).toBe("unknown");
  });

  it("absent bootstrap maps to missing with unknown rows", async () => {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const running = loadRunning(f.bootstrapPath);
    await rm(f.bootstrapPath);
    expect(resolveCronOwnerFiles(f.bootstrapPath, [], running)).toEqual([
      { state: "missing", path: f.bootstrapPath },
    ]);
    const project = (await view(f, running)).projects[0];
    expect(project?.owner).toEqual({
      state: "ambiguous",
      failedFiles: [{ file: "spur.yaml", reason: "unreadable", message: "Config file not found" }],
    });
    expect(project?.sources[0]?.disk).toBe("unknown");
  });
});

describe("cron jobs event tail", () => {
  async function writeLog(f: Fixture, lines: string[]): Promise<string> {
    const path = join(f.dataDir, "events.jsonl");
    await writeFile(path, `${lines.join("\n")}\n`);
    return path;
  }

  it("matches ticks by cron:tick and actions by triggerId, newest first, capped at 5", async () => {
    const f = await fixture();
    await writeFile(f.bootstrapPath, instanceYaml(f, demoProject(f)));
    const ticks = Array.from({ length: 7 }, (_, index) =>
      tickLine(`2026-10-2${index}T03:00:00.000Z`, "demo", "nightly"),
    );
    await writeLog(f, [
      JSON.stringify({
        timestamp: "2026-10-19T00:00:00.000Z",
        event: "daemon.start",
        level: "info",
      }),
      ...ticks,
      tickLine("2026-10-28T00:00:00.000Z", "demo", "nightly", "github:pr"),
      tickLine("2026-10-28T00:00:00.000Z", "other", "nightly"),
      actionLine("2026-10-26T03:00:01.000Z", "trigger.spawn.failed", "audit", {
        level: "error",
        message: "Spawn trigger demo/audit failed: boom",
      }),
      actionLine("2026-10-27T03:00:01.000Z", "trigger.spawn.completed", "audit", {
        sessionId: "demo-9",
        message: "should be dropped",
      }),
      actionLine("2026-10-27T04:00:00.000Z", "trigger.spawn.completed", "other-trigger", {
        sessionId: "demo-10",
      }),
      actionLine("2026-10-27T05:00:00.000Z", "trigger.spawn.matched", "audit"),
    ]);
    const response = await view(f, loadRunning(f.bootstrapPath));
    expect(response.eventsSince).toBe("2026-10-19T00:00:00.000Z");
    const source = response.projects[0]?.sources[0];
    expect(source?.recentTicks).toEqual([
      "2026-10-26T03:00:00.000Z",
      "2026-10-25T03:00:00.000Z",
      "2026-10-24T03:00:00.000Z",
      "2026-10-23T03:00:00.000Z",
      "2026-10-22T03:00:00.000Z",
    ]);
    expect(source?.triggers[0]?.recentActions).toEqual([
      {
        at: "2026-10-27T03:00:01.000Z",
        event: "trigger.spawn.completed",
        sessionId: "demo-9",
        message: null,
      },
      {
        at: "2026-10-26T03:00:01.000Z",
        event: "trigger.spawn.failed",
        sessionId: null,
        message: "Spawn trigger demo/audit failed: boom",
      },
    ]);
  });

  it("reads only the window inside maxBytes and drops the partial first line", async () => {
    const f = await fixture();
    const older = tickLine("2026-10-01T00:00:00.000Z", "demo", "nightly");
    const padding = JSON.stringify({
      timestamp: "2026-10-02T00:00:00.000Z",
      event: "padding",
      level: "info",
      message: "x".repeat(4096),
    });
    const inside = [
      tickLine("2026-10-03T00:00:00.000Z", "demo", "nightly"),
      tickLine("2026-10-04T00:00:00.000Z", "demo", "nightly"),
    ];
    await writeLog(f, [older, padding, ...inside]);
    const maxBytes = inside.join("\n").length + 2 + 100;
    const tail = await readCronEventTail(f.dataDir, maxBytes);
    expect(tail.events.map((entry) => entry.timestamp)).toEqual([
      "2026-10-03T00:00:00.000Z",
      "2026-10-04T00:00:00.000Z",
    ]);
    expect(tail.eventsSince).toBe("2026-10-03T00:00:00.000Z");
    const full = await readCronEventTail(f.dataDir, 1024 * 1024);
    expect(full.eventsSince).toBe("2026-10-01T00:00:00.000Z");
    expect(full.events).toHaveLength(3);
  });

  it("keeps events across the full large window and UTF-8 across scan chunks", async () => {
    const f = await fixture();
    const first = tickLine("2026-10-01T00:00:00.000Z", "demo", "nightly");
    const message = "failure é🙂";
    const action = actionLine("2026-10-02T00:00:00.000Z", "trigger.spawn.failed", "audit", {
      message,
    });
    const prefix = `${first}\n`;
    const emojiOffset = Buffer.byteLength(action.slice(0, action.indexOf("🙂")));
    // Split the four-byte character after its first byte at the 8 MiB boundary.
    const paddingBytes = 8 * 1024 * 1024 - Buffer.byteLength(prefix) - emojiOffset - 1;
    await writeLog(f, [
      first,
      "x".repeat(paddingBytes - 1),
      action,
      tickLine("2026-10-03T00:00:00.000Z", "demo", "nightly"),
    ]);
    const tail = await readCronEventTail(f.dataDir, 16 * 1024 * 1024);
    expect(tail.eventsSince).toBe("2026-10-01T00:00:00.000Z");
    expect(tail.events.map((entry) => entry.timestamp)).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z",
    ]);
    expect(tail.events[1]?.message).toBe(message);
  });

  it("reuses the last scan while the log size and mtime are unchanged", async () => {
    const f = await fixture();
    const path = await writeLog(f, [tickLine("2026-10-01T00:00:00.000Z", "demo", "nightly")]);
    // Whole-second mtime so restoring it below is exact.
    const mtime = new Date("2026-10-01T00:00:00.000Z");
    await utimes(path, mtime, mtime);
    const first = await readCronEventTail(f.dataDir, 1024 * 1024);
    // Same length, other content, original mtime: only a rescan would notice.
    await writeLog(f, [tickLine("2026-10-02T00:00:00.000Z", "demo", "nightly")]);
    await utimes(path, mtime, mtime);
    expect(await readCronEventTail(f.dataDir, 1024 * 1024)).toBe(first);
    await writeLog(f, [
      tickLine("2026-10-02T00:00:00.000Z", "demo", "nightly"),
      tickLine("2026-10-03T00:00:00.000Z", "demo", "nightly"),
    ]);
    const changed = await readCronEventTail(f.dataDir, 1024 * 1024);
    expect(changed.events.map((entry) => entry.timestamp)).toEqual([
      "2026-10-02T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z",
    ]);
  });

  it("returns no events and no eventsSince for a missing log", async () => {
    const f = await fixture();
    expect(await readCronEventTail(f.dataDir, 1024)).toEqual({ events: [], eventsSince: null });
  });

  it("never reads an archive next to the live log", async () => {
    const f = await fixture();
    await writeFile(
      join(f.dataDir, "events.jsonl.1.gz"),
      `${tickLine("2026-10-01T00:00:00.000Z", "demo", "nightly")}\n`,
    );
    await writeLog(f, [
      JSON.stringify({
        timestamp: "2026-10-05T00:00:00.000Z",
        event: "daemon.start",
        level: "info",
      }),
    ]);
    expect(await readCronEventTail(f.dataDir, 1024 * 1024)).toEqual({
      events: [],
      eventsSince: "2026-10-05T00:00:00.000Z",
    });
  });
});

describe("cron jobs project filter", () => {
  it("filters to a project, returns empty for a known id without cron, throws for unknown ids", async () => {
    const f = await fixture();
    await writeFile(
      f.bootstrapPath,
      instanceYaml(f, `${demoProject(f)}\n  plain:\n    path: ${f.repo}\n    sessionPrefix: plain`),
    );
    const running = loadRunning(f.bootstrapPath);
    const read = (projectId: string, known: string[] = Object.keys(running.projects)) =>
      readCronJobs({
        config: running,
        bootstrapConfigPath: f.bootstrapPath,
        registryPaths: [],
        knownProjectIds: new Set(known),
        projectId,
      });
    expect((await read("demo")).projects.map((project) => project.projectId)).toEqual(["demo"]);
    expect((await read("plain")).projects).toEqual([]);
    expect((await read("unconfigured", ["unconfigured"])).projects).toEqual([]);
    await expect(read("nope")).rejects.toBeInstanceOf(UnknownCronProjectError);
    await expect(read("nope")).rejects.toThrow("Unknown project: nope");
  });
});

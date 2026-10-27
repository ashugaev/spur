import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../src/server.js";
import type { CronJobsResponse } from "../../src/types.js";
import { cleanupTrackedTempDirs, createTempDir, findFreePort } from "../helpers/common.js";

afterEach(cleanupTrackedTempDirs);

async function bootServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  const root = await createTempDir("spur-cron-jobs-server-");
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
  await mkdir(repoDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const port = await findFreePort();
  const webhookPort = await findFreePort();
  const configPath = join(root, "spur.yaml");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      `dataDir: ${dataDir}`,
      `worktreeDir: ${join(root, "worktrees")}`,
      "projects:",
      "  demo:",
      `    path: ${repoDir}`,
      "    sources:",
      "      nightly: {type: cron, schedule: '0 3 * * *', runOnStart: false}",
      "      hook:",
      "        type: webhook",
      "        host: 127.0.0.1",
      `        port: ${webhookPort}`,
      "        path: /hook",
      "        secret: webhook-secret-x",
      "    triggers:",
      "      audit:",
      "        source: nightly",
      "        event: cron:tick",
      "        spawn:",
      "          prompt: audit sessions",
      "          overrides: {worktree: true}",
      "  plain:",
      `    path: ${repoDir}`,
      "    sessionPrefix: plain",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dataDir, "events.jsonl"),
    [
      {
        timestamp: "2026-10-27T03:00:00.000Z",
        event: "source.event.emitted",
        level: "info",
        projectId: "demo",
        sourceId: "nightly",
        details: { eventName: "cron:tick", type: "cron" },
      },
      {
        timestamp: "2026-10-27T03:00:02.000Z",
        event: "trigger.spawn.completed",
        level: "info",
        projectId: "demo",
        sourceId: "nightly",
        triggerId: "audit",
        sessionId: "demo-1",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")
      .concat("\n"),
    "utf8",
  );
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  return { port, stop: () => server.stop() };
}

describe("GET /projects/cron", () => {
  it("returns cron sources, triggers and last events, filters by project and 404s unknown ids", async () => {
    const { port, stop } = await bootServer();
    try {
      const all = await fetch(`http://127.0.0.1:${port}/projects/cron`);
      expect(all.status).toBe(200);
      const text = await all.text();
      expect(text).not.toContain("webhook-secret-x");
      expect(text).not.toContain("overrides");
      const body = JSON.parse(text) as CronJobsResponse;
      expect(body.eventsSince).toBe("2026-10-27T03:00:00.000Z");
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0]).toMatchObject({
        projectId: "demo",
        projectName: "demo",
        owner: { state: "loaded", changed: false },
        sources: [
          {
            sourceId: "nightly",
            schedule: "0 3 * * *",
            runOnStart: false,
            disk: "same",
            recentTicks: ["2026-10-27T03:00:00.000Z"],
            triggers: [
              {
                triggerId: "audit",
                event: "cron:tick",
                disk: "same",
                action: { kind: "spawn", blocks: [{ prompt: "audit sessions" }] },
                recentActions: [
                  {
                    at: "2026-10-27T03:00:02.000Z",
                    event: "trigger.spawn.completed",
                    sessionId: "demo-1",
                    message: null,
                  },
                ],
              },
            ],
          },
        ],
      });

      const filtered = await fetch(`http://127.0.0.1:${port}/projects/cron?project=demo`);
      expect(((await filtered.json()) as CronJobsResponse).projects).toHaveLength(1);

      const knownWithoutCron = await fetch(`http://127.0.0.1:${port}/projects/cron?project=plain`);
      expect(knownWithoutCron.status).toBe(200);
      expect(((await knownWithoutCron.json()) as CronJobsResponse).projects).toEqual([]);

      const unknown = await fetch(`http://127.0.0.1:${port}/projects/cron?project=nope`);
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: "Unknown project: nope" });
    } finally {
      await stop();
    }
  });
});

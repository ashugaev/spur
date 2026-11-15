import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { readEventLog } from "../../src/event-log.js";
import { cronSourceModule } from "../../src/event-sources/cron.js";
import { startServer } from "../../src/server.js";
import type { AppConfig, CronJobEditDraft, CronJobEditResult, CronJobsResponse } from "../../src/types.js";
import { cleanupTrackedTempDirs, createTempDir, findFreePort } from "../helpers/common.js";

function loadedPrompt(config: AppConfig): string | undefined {
  const trigger = config.projects["demo"]?.triggers["audit"];
  return trigger && "spawn" in trigger ? trigger.spawn.blocks[0]?.prompt : undefined;
}

it("saves cron edits while the original real source drain is pending, then activates on retry", async () => {
  const root = await createTempDir("spur-cron-drain-");
  const dataDir = join(root, "data");
  const repoDir = join(root, "repo");
  const configPath = join(root, "spur.yaml");
  const port = await findFreePort();
  expect(port).not.toBe(4310);
  let releaseDrain = () => {};
  const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
  let originalDrainCompleted = Promise.resolve();
  let sourceStarts = 0;
  let originalStopCalls = 0;
  const originalStart = cronSourceModule.start;
  // Delay completion only after stopping the real cron handle; retain later handles.
  const start = vi.spyOn(cronSourceModule, "start").mockImplementation(async (deps) => {
    const handle = await originalStart(deps);
    sourceStarts += 1;
    if (sourceStarts !== 1) return handle;
    return {
      ...handle,
      stop: () => {
        originalStopCalls += 1;
        originalDrainCompleted = (async () => {
          await handle.stop();
          await drain;
        })();
        return originalDrainCompleted;
      },
    };
  });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const base = `http://127.0.0.1:${port}`;
  const editor = `${base}/projects/cron/edit?project=demo&source=nightly&trigger=audit`;
  const runningPrompt = async () => {
    const response = await fetch(`${base}/projects/cron?project=demo`);
    expect(response.status).toBe(200);
    const body = await response.json() as CronJobsResponse;
    const action = body.projects[0]?.sources[0]?.triggers[0]?.action;
    expect(action?.kind).toBe("spawn");
    return action?.kind === "spawn" ? action.blocks[0]?.prompt : undefined;
  };
  const patch = async () => {
    const response = await fetch(editor);
    expect(response.status).toBe(200);
    const draft = await response.json() as CronJobEditDraft;
    return fetch(editor, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: draft.revision,
        schedule: draft.schedule,
        blocks: [{ ...draft.blocks[0], prompt: "edited prompt" }],
      }),
    });
  };
  try {
    await mkdir(repoDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(configPath, [
      "server:", "  host: 127.0.0.1", `  port: ${port}`,
      `dataDir: ${dataDir}`, `worktreeDir: ${join(root, "worktrees")}`,
      "projects:", "  demo:", `    path: ${repoDir}`, "    sources:",
      "      nightly: {type: cron, schedule: '0 0 1 1 *', runOnStart: false}",
      "    triggers:", "      audit:", "        source: nightly", "        event: cron:tick",
      "        spawn:", "          prompt: original prompt",
    ].join("\n"));
    server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    expect(sourceStarts).toBe(1);
    expect((await fetch(`${base}/info`)).status).toBe(200);
    expect(await runningPrompt()).toBe("original prompt");
    console.log(JSON.stringify({ phase: "owned-start", root, dataDir, port, sourceStarts }));

    const started = performance.now();
    const failed = await patch();
    const elapsedMs = performance.now() - started;
    const failedBody = await failed.json() as CronJobEditResult;
    expect(failed.status).toBe(200);
    expect(failedBody).toMatchObject({ saved: true, activation: "failed" });
    expect(elapsedMs).toBeGreaterThanOrEqual(30_000);
    expect(await readFile(configPath, "utf8")).toContain("edited prompt");
    expect(loadedPrompt(loadConfig(configPath))).toBe("edited prompt");
    expect((await fetch(`${base}/info`)).status).toBe(200);
    expect(loadedPrompt(server.config)).toBe("original prompt");
    expect(await runningPrompt()).toBe("original prompt");
    expect(sourceStarts).toBe(1);
    expect(originalStopCalls).toBe(1);
    const interrupted = readEventLog(dataDir).find((entry) => entry.event === "daemon.reload.interrupted");
    expect(interrupted?.details).toMatchObject({ state: "pending", recoveryRequired: true });
    console.log(JSON.stringify({ phase: "pending-drain", status: failed.status, body: failedBody,
      elapsedMs, sourceStarts, originalStopCalls, diskPrompt: loadedPrompt(loadConfig(configPath)),
      runtimePrompt: loadedPrompt(server.config), interrupted }));

    releaseDrain();
    await originalDrainCompleted;
    expect(sourceStarts).toBe(1);
    const retried = await patch();
    const retryBody = await retried.json() as CronJobEditResult;
    expect(retried.status).toBe(200);
    expect(retryBody).toMatchObject({ saved: true, activation: "applied" });
    expect(loadedPrompt(loadConfig(configPath))).toBe("edited prompt");
    expect(loadedPrompt(server.config)).toBe("edited prompt");
    expect(await runningPrompt()).toBe("edited prompt");
    expect(sourceStarts).toBe(2);
    expect(originalStopCalls).toBe(1);
    console.log(JSON.stringify({ phase: "recovered", status: retried.status, body: retryBody,
      sourceStarts, originalStopCalls, runtimePrompt: loadedPrompt(server.config) }));
  } finally {
    releaseDrain();
    try {
      await server?.stop();
    } finally {
      start.mockRestore();
      try {
        if (server) {
          const listening = await new Promise<boolean>((resolve, reject) => {
            const socket = createConnection({ host: "127.0.0.1", port });
            socket.once("connect", () => { socket.destroy(); resolve(true); });
            socket.once("error", (error: NodeJS.ErrnoException) => {
              if (error.code === "ECONNREFUSED") resolve(false);
              else reject(error);
            });
          });
          expect(listening).toBe(false);
          console.log(JSON.stringify({ phase: "owned-stop", port, listening }));
        }
      } finally {
        await cleanupTrackedTempDirs();
      }
    }
  }
}, 60_000);

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../../src/server.js";
import type { CronJobEditDraft, CronJobsResponse } from "../../src/types.js";
import { cleanupTrackedTempDirs, createTempDir, findFreePort } from "../helpers/common.js";

const sourceStarts = vi.hoisted(() => ({ calls: 0, failOn: new Set<number>() }));

vi.mock("../../src/event-sources/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/event-sources/index.js")>();
  return {
    ...actual,
    startConfiguredSources: async (
      ...args: Parameters<typeof actual.startConfiguredSources>
    ): ReturnType<typeof actual.startConfiguredSources> => {
      sourceStarts.calls += 1;
      if (sourceStarts.failOn.has(sourceStarts.calls)) {
        throw new Error(`injected source start failure #${sourceStarts.calls}`);
      }
      return actual.startConfiguredSources(...args);
    },
  };
});

afterEach(async () => {
  sourceStarts.calls = 0;
  sourceStarts.failOn.clear();
  await cleanupTrackedTempDirs();
});

async function boot(): Promise<{
  port: number;
  configPath: string;
  dataDir: string;
  stop: () => Promise<void>;
}> {
  const root = await createTempDir("spur-cron-edit-fail-");
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
  await mkdir(repoDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const port = await findFreePort();
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
      "    triggers:",
      "      audit:",
      "        source: nightly",
      "        event: cron:tick",
      "        spawn:",
      "          prompt: audit sessions",
    ].join("\n"),
    "utf8",
  );
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  return { port, configPath, dataDir, stop: () => server.stop() };
}

async function patchPrompt(port: number, prompt: string): Promise<Response> {
  const url = `http://127.0.0.1:${port}/projects/cron/edit?project=demo&source=nightly&trigger=audit`;
  const draft = (await (await fetch(url)).json()) as CronJobEditDraft;
  return fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      revision: draft.revision,
      schedule: draft.schedule,
      blocks: [{ ...draft.blocks[0], prompt }],
    }),
  });
}

async function reloadFailures(dataDir: string): Promise<string[]> {
  const text = await readFile(join(dataDir, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.includes('"daemon.reload.failed"'))
    .map((line) => (JSON.parse(line) as { message: string }).message);
}

async function runningPrompt(port: number): Promise<{ status: number; prompt?: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/projects/cron?project=demo`);
  if (response.status !== 200) return { status: response.status };
  const body = (await response.json()) as CronJobsResponse;
  const trigger = body.projects[0]!.sources[0]!.triggers[0]!;
  return { status: 200, prompt: trigger.action.blocks[0]!.prompt };
}

describe("PATCH /projects/cron/edit reload failure", () => {
  it("keeps YAML saved, restores previous config and logs once when reload start fails", async () => {
    const { port, configPath, dataDir, stop } = await boot();
    try {
      sourceStarts.failOn.add(sourceStarts.calls + 1);
      const response = await patchPrompt(port, "edited prompt");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ saved: true, activation: "failed" });
      expect(await readFile(configPath, "utf8")).toContain("edited prompt");
      expect(await runningPrompt(port)).toEqual({ status: 200, prompt: "audit sessions" });
      const failures = await reloadFailures(dataDir);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("previous config restored");
    } finally {
      await stop();
    }
  });

  it("logs only the rollback failure when rollback also fails and stays responsive", async () => {
    const { port, configPath, dataDir, stop } = await boot();
    try {
      sourceStarts.failOn.add(sourceStarts.calls + 1);
      sourceStarts.failOn.add(sourceStarts.calls + 2);
      const response = await patchPrompt(port, "edited prompt");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ saved: true, activation: "failed" });
      expect(await readFile(configPath, "utf8")).toContain("edited prompt");
      const failures = await reloadFailures(dataDir);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("rollback failed");
      expect((await runningPrompt(port)).status).toBe(200);
    } finally {
      await stop();
    }
  });
});

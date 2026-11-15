import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
import { TaskStatusError } from "../../src/task-status.js";
import { findFreePort } from "../helpers/common.js";

it("task-status routes validate caller/body and preserve stale-write conflict errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "spur-task-status-route-"));
  const port = await findFreePort();
  const configPath = join(root, "config.yaml");
  await writeFile(
    configPath,
    `server: {host: 127.0.0.1, port: ${port}}\ndataDir: ${join(root, "data")}\nworktreeDir: ${join(root, "worktrees")}\n`,
  );
  const read = vi
    .spyOn(SessionService.prototype, "readTaskStatus")
    .mockResolvedValue({ revision: 4 });
  const write = vi
    .spyOn(SessionService.prototype, "writeTaskStatus")
    .mockResolvedValue({ revision: 4, state: "needs_input" });
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  const url = `http://127.0.0.1:${port}/sessions/api-1/task-status`;
  const body = { state: "needs_input", revision: 4, agentLaunchId: "launch-a" };
  const post = (value: unknown, caller?: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(caller ? { "x-spur-caller-session": caller } : {}),
      },
      body: JSON.stringify(value),
    });
  try {
    expect(await (await fetch(url)).json()).toEqual({ revision: 4 });
    expect(read).toHaveBeenCalledWith("api-1");
    expect((await post(body)).status).toBe(403);
    expect((await post(body, "other")).status).toBe(403);
    expect((await post({ ...body, revision: -1 }, "api-1")).status).toBe(400);
    expect(write).not.toHaveBeenCalled();
    expect(await (await post(body, "api-1")).json()).toEqual({ revision: 4, state: "needs_input" });
    expect(write).toHaveBeenCalledWith("api-1", body);
    write.mockRejectedValueOnce(new TaskStatusError("Task changed", 409, "stale_task_status"));
    const stale = await post(body, "api-1");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_task_status" });
  } finally {
    await server.stop();
    read.mockRestore();
    write.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

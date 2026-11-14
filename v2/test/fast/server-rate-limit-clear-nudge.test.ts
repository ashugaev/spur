import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "../../src/session-service.js";
import { startServer } from "../../src/server.js";
import type * as triggersModule from "../../src/triggers.js";
import { findFreePort } from "../helpers/common.js";

const nudgeSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/triggers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof triggersModule>();
  return {
    ...actual,
    startConfiguredTriggers: (...args: Parameters<typeof actual.startConfiguredTriggers>) => {
      const controller = actual.startConfiguredTriggers(...args);
      return {
        ...controller,
        nudgeSession(sessionId: string): void {
          nudgeSpy(sessionId);
          controller.nudgeSession(sessionId);
        },
      };
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  nudgeSpy.mockReset();
});

describe("POST /sessions/:id/rate-limit/clear trigger nudge", () => {
  it.each([true, false])("nudges once only when deliveryScheduled is %s", async (scheduled) => {
    const root = await mkdtemp(join(tmpdir(), "spur-clear-nudge-http-"));
    const port = await findFreePort();
    const configPath = join(root, "config.yaml");
    await writeFile(
      configPath,
      `server: {host: 127.0.0.1, port: ${port}}\ndataDir: ${join(root, "data")}\nworktreeDir: ${join(root, "worktrees")}\n`,
    );
    const clear = vi.spyOn(SessionService.prototype, "clearRateLimit").mockResolvedValue({
      sessionId: "api-1",
      state: "waiting",
      deliveryScheduled: scheduled,
    });
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/api%2D1/rate-limit/clear`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spur-origin": "cli" },
        body: JSON.stringify({ force: true }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ deliveryScheduled: scheduled });
      expect(clear).toHaveBeenCalledWith("api-1", true, "cli");
      expect(nudgeSpy.mock.calls.map(([id]) => id)).toEqual(scheduled ? ["api-1"] : []);
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

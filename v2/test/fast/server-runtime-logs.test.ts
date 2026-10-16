import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendEventLog } from "../../src/event-log.js";
import { writeSession } from "../../src/metadata.js";
import * as runtimeTmux from "../../src/runtime-tmux.js";
import { startServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
import type { SessionRecord, SessionView } from "../../src/types.js";
import { findFreePort } from "../helpers/common.js";

const roots: string[] = [];

async function bootServer(): Promise<{
  port: number;
  dataDir: string;
  session: SessionRecord;
  stop: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "spur-runtime-logs-"));
  roots.push(root);
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
  await mkdir(repoDir, { recursive: true });
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
    ].join("\n"),
  );
  const session: SessionRecord = {
    id: "demo-1",
    project: "demo",
    agent: "claude",
    prompt: "logs",
    branch: "main",
    worktree: false,
    worktreePath: repoDir,
    tmuxSession: "demo-1",
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  };
  writeSession(dataDir, session);
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  return { port, dataDir, session, stop: () => server.stop() };
}

const runtimeView = (overrides?: Partial<SessionView>): SessionView =>
  ({
    services: [{ serviceId: "api", tmuxSession: "demo-1--service-api", runtimeAlive: true }],
    sidecars: [{ name: "web", tmuxSession: "desk-1--web", alive: true }],
    ...overrides,
  }) as SessionView;

async function logRows(
  port: number,
  sessionId: string,
  query: string,
): Promise<{
  status: number;
  body: unknown;
}> {
  const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/logs?${query}`);
  return { status: response.status, body: await response.json() };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session runtime logs route", () => {
  it("returns retained service and desk-owned sidecar lines", async () => {
    const { port, stop } = await bootServer();
    vi.spyOn(SessionService.prototype, "get").mockResolvedValue(runtimeView());
    const capture = vi
      .spyOn(runtimeTmux, "captureTmuxPane")
      .mockImplementation(async (target) =>
        target === "demo-1--service-api" ? "SERVICE_MARKER" : "SIDECAR_MARKER",
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/logs?scope=runtime`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([
        { event: "service.output", message: "SERVICE_MARKER", details: { serviceId: "api" } },
        { event: "sidecar.output", message: "SIDECAR_MARKER", details: { sidecarName: "web" } },
      ]);
      expect(capture).toHaveBeenCalledWith("desk-1--web", 200, { fresh: true });
    } finally {
      await stop();
    }
  });

  it("uses the desk sibling view and keeps unrelated sessions isolated", async () => {
    const { port, dataDir, session, stop } = await bootServer();
    writeSession(dataDir, { ...session, id: "demo-2", tmuxSession: "demo-2" });
    writeSession(dataDir, { ...session, id: "other-1", tmuxSession: "other-1" });
    vi.spyOn(SessionService.prototype, "get").mockImplementation(async (id) =>
      id === "demo-2"
        ? runtimeView({
            services: [],
            sidecars: [{ name: "web", tmuxSession: "desk-1--web", alive: true, ports: [] }],
          })
        : runtimeView({ services: [], sidecars: [] }),
    );
    const capture = vi.spyOn(runtimeTmux, "captureTmuxPane").mockResolvedValue("SIDECAR_MARKER");
    try {
      expect((await logRows(port, "demo-2", "scope=sidecar&name=web")).body).toMatchObject([
        { event: "sidecar.output", message: "SIDECAR_MARKER", sessionId: "demo-2" },
      ]);
      expect(capture).toHaveBeenCalledWith("desk-1--web", 200, { fresh: true });
      capture.mockClear();
      expect(await logRows(port, "other-1", "scope=sidecar&name=web")).toEqual({
        status: 404,
        body: { error: "No retained pane for runtime web" },
      });
      expect(await logRows(port, "other-1", "scope=sidecar&name=web&limit=0")).toEqual({
        status: 200,
        body: [],
      });
      expect(capture).not.toHaveBeenCalled();
      appendEventLog(dataDir, {
        event: "sidecar.output",
        level: "info",
        sessionId: "other-1",
        message: "ARCHIVED_ONLY",
        details: { sidecarName: "web" },
      });
      expect((await logRows(port, "other-1", "scope=sidecar&name=web")).body).toMatchObject([
        { message: "ARCHIVED_ONLY" },
      ]);
    } finally {
      await stop();
    }
  });

  it("keeps archived order, then sorted pane tails, under one global limit", async () => {
    const { port, dataDir, stop } = await bootServer();
    appendEventLog(dataDir, {
      event: "session.spawn.completed",
      level: "info",
      sessionId: "demo-1",
      message: "ARCHIVE",
    });
    vi.spyOn(SessionService.prototype, "get").mockResolvedValue(
      runtimeView({
        services: [
          { serviceId: "z", tmuxSession: "z-pane", runtimeAlive: true },
          { serviceId: "a", tmuxSession: "a-pane", runtimeAlive: true },
        ] as SessionView["services"],
        sidecars: [
          { name: "z", tmuxSession: "z-sidecar", alive: true },
          { name: "a", tmuxSession: "a-sidecar", alive: true },
        ] as SessionView["sidecars"],
      }),
    );
    vi.spyOn(runtimeTmux, "captureTmuxPane").mockImplementation(async (target) => target);
    try {
      const all = await logRows(port, "demo-1", "scope=all");
      expect((all.body as { message: string }[]).map((row) => row.message).slice(-5)).toEqual([
        "ARCHIVE",
        "a-pane",
        "z-pane",
        "a-sidecar",
        "z-sidecar",
      ]);
      const limited = await logRows(port, "demo-1", "scope=all&limit=2");
      expect((limited.body as { message: string }[]).map((row) => row.message)).toEqual([
        "ARCHIVE",
        "a-pane",
      ]);
      expect((await logRows(port, "demo-1", "scope=service&name=z")).body).toMatchObject([
        { message: "z-pane", event: "service.output" },
      ]);
      expect((await logRows(port, "demo-1", "scope=sidecar&name=a")).body).toMatchObject([
        { message: "a-sidecar", event: "sidecar.output" },
      ]);
      expect((await logRows(port, "demo-1", "scope=runtime&limit=0")).body).toEqual([]);
    } finally {
      await stop();
    }
  });

  it("keeps a service failure beside 200 sidecar lines under the default cap", async () => {
    const { port, stop } = await bootServer();
    vi.spyOn(SessionService.prototype, "get").mockResolvedValue(runtimeView());
    const sidecarLines = Array.from({ length: 200 }, (_, index) => `SIDE_${index + 1}`);
    vi.spyOn(runtimeTmux, "captureTmuxPane").mockImplementation(async (target) =>
      target === "demo-1--service-api" ? "FRESH_FAILURE" : sidecarLines.join("\n"),
    );
    try {
      const result = await logRows(port, "demo-1", "scope=runtime");
      expect(result.status).toBe(200);
      const rows = result.body as { message: string }[];
      expect(rows).toHaveLength(200);
      expect(rows.map((row) => row.message)).toEqual(["FRESH_FAILURE", ...sidecarLines.slice(1)]);
      const sidecarOnly = await logRows(port, "demo-1", "scope=sidecar&limit=2");
      expect((sidecarOnly.body as { message: string }[]).map((row) => row.message)).toEqual([
        "SIDE_199",
        "SIDE_200",
      ]);
    } finally {
      await stop();
    }
  });

  it("distinguishes a blank pane, a failed capture, and a named absent pane", async () => {
    const { port, dataDir, stop } = await bootServer();
    const get = vi.spyOn(SessionService.prototype, "get").mockResolvedValue(
      runtimeView({
        services: [],
        sidecars: [
          { name: "web", tmuxSession: "desk-1--web", alive: false, deadPane: true, ports: [] },
        ],
      }),
    );
    const capture = vi.spyOn(runtimeTmux, "captureTmuxPane").mockResolvedValue("");
    try {
      expect(await logRows(port, "demo-1", "scope=sidecar&name=web")).toEqual({
        status: 200,
        body: [],
      });
      capture.mockResolvedValue(null);
      const failed = await logRows(port, "demo-1", "scope=sidecar&name=web");
      expect(failed.status).toBe(502);
      expect(failed.body).toMatchObject({ error: expect.stringContaining("Failed to capture") });
      get.mockResolvedValue(
        runtimeView({
          services: [],
          sidecars: [{ name: "web", tmuxSession: "desk-1--web", alive: false, ports: [] }],
        }),
      );
      const missing = await logRows(port, "demo-1", "scope=sidecar&name=web");
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ error: expect.stringContaining("No retained pane") });
      expect(await logRows(port, "demo-1", "scope=sidecar")).toEqual({ status: 200, body: [] });
      appendEventLog(dataDir, {
        event: "sidecar.output",
        level: "info",
        sessionId: "demo-1",
        message: "OLD",
        details: { sidecarName: "web" },
      });
      expect((await logRows(port, "demo-1", "scope=sidecar&name=web")).body).toMatchObject([
        { message: "OLD", event: "sidecar.output" },
      ]);
      get.mockResolvedValue(
        runtimeView({
          services: [
            {
              serviceId: "api",
              tmuxSession: "api-pane",
              runtimeAlive: false,
            } as SessionView["services"][number],
          ],
          sidecars: [],
        }),
      );
      expect((await logRows(port, "demo-1", "scope=service&name=api")).status).toBe(404);
      appendEventLog(dataDir, {
        event: "service.output",
        level: "info",
        sessionId: "demo-1",
        message: "SERVICE_OLD",
        details: { serviceId: "api" },
      });
      expect((await logRows(port, "demo-1", "scope=service&name=api")).body).toMatchObject([
        { message: "SERVICE_OLD", event: "service.output" },
      ]);
      get.mockResolvedValue(
        runtimeView({
          services: [
            {
              serviceId: "api",
              tmuxSession: "api-pane",
              runtimeAlive: true,
            } as SessionView["services"][number],
          ],
          sidecars: [],
        }),
      );
      expect((await logRows(port, "demo-1", "scope=service&name=api")).status).toBe(502);
    } finally {
      await stop();
    }
  });

  it("keeps archived rows available after the session record is removed", async () => {
    const { port, dataDir, session, stop } = await bootServer();
    appendEventLog(dataDir, {
      event: "service.output",
      level: "info",
      sessionId: "demo-1",
      message: "OLD",
      details: { serviceId: "api" },
    });
    const get = vi.spyOn(SessionService.prototype, "get");
    await rm(join(dataDir, "sessions", session.project, `${session.id}.json`));
    try {
      expect((await logRows(port, "demo-1", "scope=service&name=api&limit=1")).body).toMatchObject([
        { event: "service.output", message: "OLD" },
      ]);
      expect(await logRows(port, "demo-1", "scope=sidecar&name=unknown")).toEqual({
        status: 200,
        body: [],
      });
      expect(get).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  });
});

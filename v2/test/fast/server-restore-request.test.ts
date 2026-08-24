import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRestoreSessionRequest, startServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
import type { SessionView } from "../../src/types.js";
import { findFreePort } from "../helpers/common.js";

describe("parseRestoreSessionRequest", () => {
  it("defaults to {} on an absent or non-object body", () => {
    expect(parseRestoreSessionRequest(undefined)).toEqual({});
    expect(parseRestoreSessionRequest(null)).toEqual({});
    expect(parseRestoreSessionRequest("nope")).toEqual({});
  });

  it("keeps force:true, drops force:false", () => {
    expect(parseRestoreSessionRequest({ force: true })).toEqual({ force: true });
    expect(parseRestoreSessionRequest({ force: false })).toEqual({});
  });

  it("ignores an unrecognized field", () => {
    expect(parseRestoreSessionRequest({ other: "x" })).toEqual({});
  });
});

// A8: the override reaches the daemon over HTTP and is forwarded unchanged
// to the service call — this is the only body either route reads.
describe("POST /sessions/:id/restore and /reopen forward the force override", () => {
  async function withServer(run: (port: number) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "spur-server-test-"));
    const repoDir = join(root, "repo");
    const dataDir = join(root, "data");
    const worktreeDir = join(root, "worktrees");
    const port = await findFreePort();
    await mkdir(repoDir, { recursive: true });
    const configPath = join(root, "spur.yaml");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        `  port: ${port}`,
        `dataDir: ${dataDir}`,
        `worktreeDir: ${worktreeDir}`,
        "projects:",
        "  demo:",
        `    path: ${repoDir}`,
      ].join("\n"),
      "utf8",
    );
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    try {
      await run(port);
    } finally {
      await server.stop();
    }
  }

  it("passes {force:true} from the restore body through to service.restore", async () => {
    const originalRestore = SessionService.prototype.restore;
    const calls: unknown[] = [];
    SessionService.prototype.restore = async function mockRestore(sessionId, request) {
      calls.push(request);
      return { id: sessionId, status: "running" } as unknown as SessionView;
    };
    try {
      await withServer(async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/restore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: true }),
        });
        expect(response.status).toBe(200);
        expect(calls).toEqual([{ force: true }]);
      });
    } finally {
      SessionService.prototype.restore = originalRestore;
    }
  });

  it("defaults to {} when the restore body is empty", async () => {
    const originalRestore = SessionService.prototype.restore;
    const calls: unknown[] = [];
    SessionService.prototype.restore = async function mockRestore(sessionId, request) {
      calls.push(request);
      return { id: sessionId, status: "running" } as unknown as SessionView;
    };
    try {
      await withServer(async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/restore`, {
          method: "POST",
        });
        expect(response.status).toBe(200);
        expect(calls).toEqual([{}]);
      });
    } finally {
      SessionService.prototype.restore = originalRestore;
    }
  });

  it("passes {force:true} from the reopen body through to service.reopen", async () => {
    const originalReopen = SessionService.prototype.reopen;
    const calls: unknown[] = [];
    SessionService.prototype.reopen = async function mockReopen(sessionId, request) {
      calls.push(request);
      return { id: sessionId, status: "running" } as unknown as SessionView;
    };
    try {
      await withServer(async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/reopen`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: true }),
        });
        expect(response.status).toBe(200);
        expect(calls).toEqual([{ force: true }]);
      });
    } finally {
      SessionService.prototype.reopen = originalReopen;
    }
  });
});

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCompleteSessionRequest,
  parseRestoreSessionRequest,
  startServer,
} from "../../src/server.js";
import {
  annotateLifecycleError,
  SessionLifecycleError,
  SessionLifecycleRegister,
} from "../../src/session-lifecycle.js";
import { SessionService } from "../../src/session-service.js";
import type { SessionView } from "../../src/types.js";
import { findFreePort } from "../helpers/common.js";

describe("parseRestoreSessionRequest", () => {
  it.each([parseCompleteSessionRequest, parseRestoreSessionRequest])(
    "validates operation IDs before forwarding",
    (parse) => {
      expect(parse({ operationId: "client-operation" })).toEqual({
        operationId: "client-operation",
      });
      for (const operationId of [null, 4, "", " padded", "x".repeat(129)]) {
        expect(() => parse({ operationId })).toThrow("operationId");
      }
    },
  );
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

  it("requires an explicit boolean token budget approval", () => {
    expect(parseRestoreSessionRequest({ overrideTokenBudget: true })).toEqual({
      overrideTokenBudget: true,
    });
    expect(parseRestoreSessionRequest({ overrideTokenBudget: "true" })).toEqual({});
    expect(parseRestoreSessionRequest({ overrideTokenBudget: false })).toEqual({});
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

  it("forwards IDs to complete, restore, and reopen and rejects malformed IDs before execution", async () => {
    const restore = SessionService.prototype.restore;
    const reopen = SessionService.prototype.reopen;
    const complete = SessionService.prototype.complete;
    const calls: unknown[] = [];
    const mock: typeof restore = async (id, request) => {
      calls.push(request);
      return { id } as SessionView;
    };
    SessionService.prototype.restore = mock;
    SessionService.prototype.reopen = mock;
    SessionService.prototype.complete = mock;
    try {
      await withServer(async (port) => {
        for (const action of ["complete", "restore", "reopen"]) {
          const valid = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId: action }),
          });
          expect(valid.status).toBe(200);
          const invalid = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId: " invalid " }),
          });
          expect(invalid.status).toBe(400);
        }
        expect(calls).toEqual([
          { operationId: "complete" },
          { operationId: "restore" },
          { operationId: "reopen" },
        ]);
      });
    } finally {
      SessionService.prototype.restore = restore;
      SessionService.prototype.reopen = reopen;
      SessionService.prototype.complete = complete;
    }
  });

  it("attaches producing identity to an empty list", async () => {
    await withServer(async (port) => {
      const info = (await (await fetch(`http://127.0.0.1:${port}/info`)).json()) as {
        lifecycleInstanceId: string;
      };
      const response = await fetch(`http://127.0.0.1:${port}/sessions?view=dashboard`);
      expect(response.headers.get("x-spur-lifecycle-instance-id")).toBe(info.lifecycleInstanceId);
      expect(await response.json()).toEqual([]);
    });
  });

  it("preserves the captured settled receipt on delivery 503 while a newer owner exists", async () => {
    const original = SessionService.prototype.restore;
    const register = new SessionLifecycleRegister();
    const owner = register.begin("restore", ["demo-1"], "old");
    const settled = register.settle(
      owner,
      true,
      () => "succeeded",
      () => true,
    );
    const newer = register.begin("reopen", ["demo-1"], "new");
    SessionService.prototype.restore = async () => {
      const error = new SessionLifecycleError("Delivery changed", 503, {
        code: "session_lifecycle_snapshot_changed",
        lifecycle: newer,
      });
      annotateLifecycleError(error, settled);
      throw error;
    };
    try {
      await withServer(async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/sessions/demo-1/restore`, {
          method: "POST",
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: "Delivery changed",
          code: "session_lifecycle_snapshot_changed",
          lifecycle: settled,
        });
        expect(register.snapshot("demo-1")).toBe(newer);
      });
    } finally {
      SessionService.prototype.restore = original;
    }
  });

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
          body: JSON.stringify({ force: true, overrideTokenBudget: true }),
        });
        expect(response.status).toBe(200);
        expect(calls).toEqual([{ force: true, overrideTokenBudget: true }]);
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

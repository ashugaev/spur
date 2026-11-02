import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSession } from "../../src/metadata.js";
import { resolveTodoMutationActor, startServer, type StartedServer } from "../../src/server.js";
import type { SessionRecord, TodoProjection } from "../../src/types.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const servers: StartedServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function fixture() {
  const root = await createTempDir("spur-todo-actor-");
  const dataDir = join(root, "data");
  const repoDir = join(root, "repo");
  const port = await findFreePort();
  await mkdir(repoDir);
  const configPath = join(root, "config.yaml");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      `dataDir: ${dataDir}`,
      `worktreeDir: ${join(root, "worktrees")}`,
      "projects:",
      "  test:",
      `    path: ${repoDir}`,
    ].join("\n"),
  );
  const session: SessionRecord = {
    id: "test-actor",
    project: "test",
    agent: "codex",
    prompt: "Test ToDo actor provenance",
    branch: "feature/test-actor",
    worktree: true,
    worktreePath: repoDir,
    tmuxSession: "test-actor",
    launchCommand: "codex",
    status: "stopped",
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
  writeSession(dataDir, session);
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  servers.push(server);
  return { server, dataDir, session, url: `http://127.0.0.1:${port}/sessions` };
}

describe("ToDo actor identity", () => {
  it("accepts MCP as a human operator and rejects MCP session impersonation", async () => {
    const lookup = vi.fn();
    await expect(
      resolveTodoMutationActor({
        origin: "mcp",
        callerHeader: undefined,
        targetSessionId: "target",
        lookup,
      }),
    ).resolves.toEqual({ kind: "human", origin: "mcp" });
    await expect(
      resolveTodoMutationActor({
        origin: "mcp",
        callerHeader: "target",
        targetSessionId: "target",
        lookup,
      }),
    ).rejects.toThrow("Caller session requires CLI origin");
    expect(lookup).not.toHaveBeenCalled();
  });
  it("projects fresh stored identity without returning the session record", async () => {
    const { server, dataDir, session } = await fixture();
    expect(server.getSessionIdentity(session.id)).toEqual({ id: session.id, agent: "codex" });
    writeSession(dataDir, { ...session, agent: "cursor" });
    expect(server.getSessionIdentity(session.id)).toEqual({ id: session.id, agent: "cursor" });
  });

  it("persists an agent mutation while full session lookup remains held", async () => {
    const { server, dataDir, session, url } = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const lookupEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const get = vi.spyOn(server, "get").mockImplementation(async () => {
      entered();
      await held;
      throw new Error("Held full session lookup released");
    });
    const fullView = fetch(`${url}/${session.id}`);
    await lookupEntered;
    const mutation = fetch(`${url}/${session.id}/todo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-spur-origin": "cli",
        "x-spur-caller-session": session.id,
      },
      body: JSON.stringify({ action: "add", text: "Record the step", reason: "Test provenance" }),
      signal: AbortSignal.timeout(1000),
    });
    try {
      const response = await mutation;
      expect(response.status).toBe(200);
      const projection = (await response.json()) as TodoProjection;
      const actor = { kind: "agent", agent: "codex", sessionId: session.id };
      expect(projection.items[0]?.added.actor).toEqual(actor);
      const ledger = await readFile(join(dataDir, "sessions", session.id, "todo.jsonl"), "utf8");
      expect(JSON.parse(ledger.trim())).toMatchObject({ type: "item_added", actor });
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.allSettled([fullView, mutation]);
    }
  });

  it("keeps missing-agent lookup ahead of malformed JSON, and human parsing ahead of target lookup", async () => {
    const { url } = await fixture();
    for (const [caller, status] of [
      ["missing", 404],
      [undefined, 400],
    ] as const) {
      const response = await fetch(`${url}/missing/todo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-spur-origin": "cli",
          ...(caller ? { "x-spur-caller-session": caller } : {}),
        },
        body: "{",
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(
        caller
          ? { error: "Session not found: missing" }
          : { code: "invalid_todo_request", error: "Invalid JSON in request body" },
      );
    }
  });

  for (const origin of ["cli", "ui"] as const) {
    it(`preserves caller-free ${origin} mutations as human`, async () => {
      const { server, session, url } = await fixture();
      const identity = vi.spyOn(server, "getSessionIdentity");
      const response = await fetch(`${url}/${session.id}/todo`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spur-origin": origin },
        body: JSON.stringify({ action: "add", text: "Human step", reason: "Test provenance" }),
      });
      expect(response.status).toBe(200);
      const projection = (await response.json()) as TodoProjection;
      expect(projection.items[0]?.added.actor).toEqual({ kind: "human", origin });
      expect(identity).not.toHaveBeenCalled();
    });
  }

  for (const asynchronous of [false, true]) {
    it(`accepts ${asynchronous ? "asynchronous" : "synchronous"} identity lookup`, async () => {
      const identity = { id: "test-actor", agent: "codex" as const };
      const lookup = vi.fn(() => (asynchronous ? Promise.resolve(identity) : identity));
      await expect(
        resolveTodoMutationActor({
          origin: "cli",
          callerHeader: identity.id,
          targetSessionId: identity.id,
          lookup,
        }),
      ).resolves.toEqual({ kind: "agent", agent: identity.agent, sessionId: identity.id });
      expect(lookup).toHaveBeenCalledExactlyOnceWith(identity.id);
    });
  }

  it("rejects invalid caller metadata before lookup", async () => {
    const lookup = vi.fn(async () => ({ id: "test-actor", agent: "codex" as const }));
    for (const request of [
      { origin: "cli", callerHeader: ["test-actor"] },
      { origin: "ui", callerHeader: "test-actor" },
      { origin: "cli", callerHeader: "other" },
      { origin: "unknown", callerHeader: undefined },
    ] satisfies Array<{
      origin: "cli" | "ui" | "unknown";
      callerHeader: string | string[] | undefined;
    }>) {
      await expect(
        resolveTodoMutationActor({ ...request, targetSessionId: "test-actor", lookup }),
      ).rejects.toThrow();
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});

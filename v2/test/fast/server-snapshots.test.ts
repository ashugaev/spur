import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEventLog, resetEventLogCollapse } from "../../src/event-log.js";
import { writeSession } from "../../src/metadata.js";
import { startServer, type StartedServer } from "../../src/server.js";
import type { SessionRecord } from "../../src/types.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function fixture(extraProjectYaml: string[] = []) {
  resetEventLogCollapse();
  const root = await createTempDir("spur-server-snapshots-");
  const dataDir = join(root, "data");
  const repoDir = join(root, "repo");
  const port = await findFreePort();
  await mkdir(repoDir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git("init", "-b", "main");
  git("-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
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
      ...extraProjectYaml,
    ].join("\n"),
  );
  const session: SessionRecord = {
    id: "snap-owner",
    project: "test",
    agent: "codex",
    model: "gpt-test",
    prompt: "Snapshot test",
    branch: "feature/snap",
    worktree: true,
    worktreePath: repoDir,
    tmuxSession: "snap-owner",
    launchCommand: "codex",
    status: "stopped",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    slots: { links: [{ label: "PR", url: "https://example.test/pr/1" }] },
  };
  writeSession(dataDir, session);
  writeSession(dataDir, { ...session, id: "snap-other", tmuxSession: "snap-other" });
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  servers.push(server);
  const url = `http://127.0.0.1:${port}/sessions`;
  const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/${id}/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { dataDir, session, url, post, repoDir };
}

const agentHeaders = (id: string) => ({ "x-spur-origin": "cli", "x-spur-caller-session": id });

describe("snapshot routes", () => {
  it("fills metadata for a session-owned write", async () => {
    const { post, url } = await fixture();
    const response = await post(
      "snap-owner",
      { content: "# Now\nstep" },
      agentHeaders("snap-owner"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 1,
      sessionId: "snap-owner",
      project: "test",
      agent: "codex",
      model: "gpt-test",
      branch: "main",
      dirty: false,
      todoRevision: "",
      links: [{ label: "PR", url: "https://example.test/pr/1" }],
      trigger: "manual",
      final: false,
    });
    const stored = (await fetch(`${url}/snap-owner/snapshots/1`).then((r) => r.json())) as {
      headSha: string;
    };
    expect(stored.headSha).toMatch(/^[0-9a-f]{40}$/);
    const full = await fetch(`${url}/snap-owner/snapshots/1`);
    expect(await full.json()).toMatchObject({ version: 1, content: "# Now\nstep" });
  });

  it("records a dirty worktree after an untracked file appears", async () => {
    const { post, repoDir } = await fixture();
    await writeFile(join(repoDir, "scratch.txt"), "x");
    const response = await post("snap-owner", { content: "dirty" }, { "x-spur-origin": "cli" });
    expect(await response.json()).toMatchObject({ dirty: true });
  });

  it("stores final writes and serves latest and the list", async () => {
    const { post, url } = await fixture();
    await post("snap-owner", { content: "one" }, { "x-spur-origin": "mcp" });
    const final = await post(
      "snap-owner",
      { content: "two", final: true },
      { "x-spur-origin": "mcp" },
    );
    expect(await final.json()).toMatchObject({ version: 2, final: true, trigger: "final" });
    const latest = await fetch(`${url}/snap-owner/snapshots/latest`);
    expect(await latest.json()).toMatchObject({ version: 2, content: "two" });
    const list = (await (await fetch(`${url}/snap-owner/snapshots`)).json()) as Array<
      Record<string, unknown>
    >;
    expect(list.map((entry) => entry["version"])).toEqual([1, 2]);
    expect(list[0]).not.toHaveProperty("content");
  });

  it("rejects a foreign caller session and stores nothing", async () => {
    const { post, dataDir } = await fixture();
    const response = await post("snap-owner", { content: "x" }, agentHeaders("snap-other"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_snapshot_request" });
    const mcp = await post(
      "snap-owner",
      { content: "x" },
      {
        "x-spur-origin": "mcp",
        "x-spur-caller-session": "snap-owner",
      },
    );
    expect(mcp.status).toBe(400);
    const dir = join(dataDir, "sessions", "snap-owner", "snapshots");
    await expect(readdir(dir)).rejects.toThrow();
  });

  it("validates the body shape", async () => {
    const { post } = await fixture();
    const headers = { "x-spur-origin": "cli" };
    for (const body of [
      { content: "x", extra: 1 },
      { content: 3 },
      { content: "   " },
      {},
      { content: "x", final: "yes" },
      { content: "x", trigger: "timer" },
      "[1]",
      "{",
    ]) {
      const response = await post("snap-owner", body, headers);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_snapshot_request" });
    }
  });

  it("returns 400 for a body over 1MB", async () => {
    const { post, url } = await fixture();
    const response = await post("snap-owner", JSON.stringify({ content: "x".repeat(1_000_001) }), {
      "x-spur-origin": "cli",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_snapshot_request" });
    expect(await (await fetch(`${url}/snap-owner/snapshots`)).json()).toEqual([]);
  });

  it("refuses oversize content with both numbers", async () => {
    const { post } = await fixture(["    snapshots:", "      maxBytes: 10"]);
    const response = await post(
      "snap-owner",
      { content: "é".repeat(6) },
      { "x-spur-origin": "cli" },
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      code: "snapshot_too_large",
      limitBytes: 10,
      actualBytes: 12,
      error: "Snapshot is 12 bytes; limit is 10 bytes (projects.test.snapshots.maxBytes).",
    });
  });

  it("maps read errors", async () => {
    const { url } = await fixture();
    expect((await fetch(`${url}/snap-owner/snapshots/latest`)).status).toBe(404);
    expect((await fetch(`${url}/snap-owner/snapshots/3`)).status).toBe(404);
    expect((await fetch(`${url}/missing/snapshots`)).status).toBe(404);
    for (const version of ["0", "abc", "-1", "1.5"]) {
      const response = await fetch(`${url}/snap-owner/snapshots/${version}`);
      expect(response.status, version).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_snapshot_request" });
    }
  });

  it("refuses an agent complete without a final snapshot when requireFinal is set", async () => {
    const { dataDir, url } = await fixture(["    snapshots:", "      requireFinal: true"]);
    const headers = { "content-type": "application/json", ...agentHeaders("snap-owner") };
    const todo = (body: unknown) =>
      fetch(`${url}/snap-owner/todo`, { method: "POST", headers, body: JSON.stringify(body) });
    const added = (await (await todo({ action: "add", text: "step", reason: "why" })).json()) as {
      items: Array<{ id: string }>;
    };
    await todo({ action: "complete", itemId: added.items[0]?.id, reason: "done" });
    const response = await fetch(`${url}/snap-owner/complete`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "work_snapshot_required",
      sessionId: "snap-owner",
      required: "final",
    });
    expect(readEventLog(dataDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "http.request.failed",
          level: "warn",
          path: "/sessions/snap-owner/complete",
        }),
      ]),
    );
  });
});

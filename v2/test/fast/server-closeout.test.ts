import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCloseoutArchive } from "../../src/closeout-archive.js";
import { resetEventLogCollapse } from "../../src/event-log.js";
import { archiveSessions, writeSession } from "../../src/metadata.js";
import { startServer, type StartedServer } from "../../src/server.js";
import type { SessionRecord } from "../../src/types.js";
import { createTempDir, findFreePort } from "../helpers/common.js";

const servers: StartedServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

const LINK_URL = "https://example.test/pr/1";

async function fixture() {
  resetEventLogCollapse();
  const root = await createTempDir("spur-server-closeout-");
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
    ].join("\n"),
  );
  const record = (id: string, status: SessionRecord["status"]): SessionRecord => ({
    id,
    project: "test",
    agent: "codex",
    model: "gpt-test",
    prompt: "Closeout test",
    branch: `feature/${id}`,
    worktree: true,
    worktreePath: repoDir,
    tmuxSession: id,
    launchCommand: "codex",
    status,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    slots: { links: [{ label: "board-worker", url: LINK_URL }] },
  });
  const archive = async (session: SessionRecord, completedAt: string, files: string[]) => {
    const source = join(root, `src-${session.id}`);
    mkdirSync(source, { recursive: true });
    for (const name of files) writeFileSync(join(source, name), `bytes of ${name}`);
    await writeCloseoutArchive({
      sessionDir: join(dataDir, "sessions", session.id),
      sessionId: session.id,
      project: "test",
      completedAt,
      links: [{ label: "board-worker", url: LINK_URL }],
      snapshotVersion: null,
      headSha: null,
      roots: { artifacts: source, work: null, workspace: null },
      include: ["artifacts:**"],
      maxBytes: 1000,
    });
  };
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  return { dataDir, base, record, archive, root };
}

describe("closeout routes", () => {
  it("serves manifest and files for live and archived sessions", async () => {
    const { dataDir, base, record, archive } = await fixture();
    const done = record("co-done", "completed");
    writeSession(dataDir, done);
    await archive(done, "2026-11-02T00:00:00.000Z", ["a.txt"]);

    const manifest = await fetch(`${base}/sessions/co-done/closeout`);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({
      sessionId: "co-done",
      files: [{ root: "artifacts", path: "a.txt", bytes: 14 }],
    });
    const file = await fetch(`${base}/sessions/co-done/closeout/files/artifacts/a.txt`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("bytes of a.txt");
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect(file.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");

    archiveSessions(dataDir, [done]);
    expect((await fetch(`${base}/sessions/co-done/closeout`)).status).toBe(200);
    const again = await fetch(`${base}/sessions/co-done/closeout/files/artifacts/a.txt`);
    expect(await again.text()).toBe("bytes of a.txt");
  });

  it("answers 404 for unsafe paths, unknown roots, symlinks and sessions without an archive", async () => {
    const { dataDir, base, record, archive } = await fixture();
    const done = record("co-done", "completed");
    writeSession(dataDir, done);
    await archive(done, "2026-11-02T00:00:00.000Z", ["a.txt"]);
    symlinkSync(
      join(dataDir, "sessions", "co-done", "closeout", "closeout.json"),
      join(dataDir, "sessions", "co-done", "closeout", "files", "artifacts", "esc"),
    );
    writeSession(dataDir, record("co-none", "completed"));

    const files = `${base}/sessions/co-done/closeout/files`;
    for (const tail of [
      "artifacts/..%2F..%2Fcloseout.json",
      "artifacts/%2e%2e/closeout.json",
      "artifacts/%E0%A4%A",
      "other/a.txt",
      "artifacts/esc",
      "artifacts/missing.txt",
    ]) {
      expect((await fetch(`${files}/${tail}`)).status, tail).toBe(404);
    }
    expect((await fetch(`${base}/sessions/co-none/closeout`)).status).toBe(404);
    expect((await fetch(`${base}/sessions/unknown/closeout`)).status).toBe(404);
  });

  it("lists closeouts by link across live and archived sessions", async () => {
    const { dataDir, base, record, archive } = await fixture();
    const live = record("co-live", "completed");
    const old = record("co-old", "completed");
    writeSession(dataDir, live);
    writeSession(dataDir, old);
    writeSession(dataDir, record("co-bare", "completed"));
    await archive(live, "2026-11-03T00:00:00.000Z", ["a.txt"]);
    await archive(old, "2026-11-02T00:00:00.000Z", ["b.txt"]);
    archiveSessions(dataDir, [old]);

    const response = await fetch(`${base}/closeouts?link=board-worker=${LINK_URL}`);
    expect(response.status).toBe(200);
    const entries = (await response.json()) as Array<{ sessionId: string; status: string }>;
    expect(entries.map((entry) => entry.sessionId)).toEqual(["co-live", "co-old"]);

    expect((await fetch(`${base}/closeouts`)).status).toBe(400);
    expect((await fetch(`${base}/closeouts?link=Bad Label`)).status).toBe(400);
  });

  it("returns closeout_corrupt for an unusable manifest", async () => {
    const { dataDir, base, record, archive } = await fixture();
    const done = record("co-bad", "completed");
    writeSession(dataDir, done);
    await archive(done, "2026-11-02T00:00:00.000Z", []);
    writeFileSync(join(dataDir, "sessions", "co-bad", "closeout", "closeout.json"), "{nope");
    const response = await fetch(`${base}/sessions/co-bad/closeout`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "closeout_corrupt" });
  });

  it("reads the ToDo of an archived session", async () => {
    const { dataDir, base, record } = await fixture();
    const session = record("co-todo", "stopped");
    writeSession(dataDir, session);
    const headers = {
      "content-type": "application/json",
      "x-spur-origin": "cli",
      "x-spur-caller-session": "co-todo",
    };
    const added = await fetch(`${base}/sessions/co-todo/todo`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "add", text: "step", reason: "why" }),
    });
    expect(added.status).toBe(200);
    archiveSessions(dataDir, [session]);

    const response = await fetch(`${base}/sessions/co-todo/todo`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ text: "step" }] });
    expect((await fetch(`${base}/sessions/unknown/todo`)).status).toBe(404);
  });
});

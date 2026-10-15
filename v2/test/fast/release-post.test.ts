import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  continueReleasePost,
  parseReleasePostPolicy,
  type ReleasePostDependencies,
  type VerifiedRelease,
} from "../../src/release-post.js";
import { captureReleaseTaskIdentity } from "../../src/session-service.js";
import type { SessionRecord } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await createTempDir("release-post-");
  roots.push(root);
  const dataDir = join(root, "data"),
    worktree = join(root, "worktree"),
    artifacts = join(dataDir, "session-artifacts", "worker"),
    receiptRoot = join(root, "receipts");
  await mkdir(worktree);
  await mkdir(artifacts, { recursive: true });
  await mkdir(join(receiptRoot, "owner", "repo", "5"), { recursive: true });
  await writeFile(join(artifacts, "evidence.txt"), "review proof");
  await writeFile(join(receiptRoot, "owner", "repo", "5", "code.json"), "code receipt");
  const history = join(root, "history.json");
  await writeFile(history, "native history");
  const sessions = new Map<string, SessionRecord>();
  for (const id of ["worker", "code", "browser", "predecessor", "child"])
    sessions.set(id, {
      id,
      project: "project",
      workspaceId: "worker",
      agent: "codex",
      prompt: "task",
      branch: "feature/task",
      pr: { repo: "owner/repo", number: 5, url: "https://github.com/owner/repo/pull/5" },
      worktree: true,
      worktreePath: worktree,
      tmuxSession: id,
      launchCommand: "agent",
      agentLaunchId: `${id}-launch`,
      status: id === "predecessor" ? "paused" : "running",
      createdAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
    });
  const policy = parseReleasePostPolicy({
    repository: "owner/repo",
    pr: 5,
    generation: 1,
    archiveRoot: join(root, "archive"),
    members: [...sessions.values()].map((session) => ({
      sessionId: session.id,
      role: session.id === "worker" ? "worker" : session.id === "child" ? "child" : "reviewer",
      project: session.project,
      workspaceId: "worker",
      branch: session.branch,
      taskDigest: captureReleaseTaskIdentity(session).taskDigest,
    })),
    evidence: [history],
    change: "Внутреннее восстановление",
    flow: "Проверки сохранены; неопределённая доставка не повторяется",
    telegram: { recipient: 77, targetProof: { file: "private", digest: "f".repeat(64) } },
  });
  const release: VerifiedRelease = {
    repository: "owner/repo",
    pr: 5,
    mergeSha: "a".repeat(40),
    version: "1.2.3",
    gitHead: "b".repeat(40),
    integrity: "sha512-proof",
    deploymentDigest: "c".repeat(64),
  };
  const calls: string[] = [];
  const complete = vi.fn<ReleasePostDependencies["complete"]>(async (id, guard) => {
    const manifest = await readFile(guard.archive.path, "utf8");
    expect(createHash("sha256").update(manifest).digest("hex")).toBe(guard.archive.digest);
    expect(await readFile(join(dirname(guard.archive.path), "1", "evidence.txt"), "utf8")).toBe(
      "review proof",
    );
    expect(await readdir(join(policy.archiveRoot, JSON.parse(manifest).key))).toContain(
      "manifest.json",
    );
    calls.push(id);
    const session = sessions.get(id);
    if (session) session.status = "completed";
    if (id === "worker") {
      await rm(worktree, { recursive: true });
      await rm(artifacts, { recursive: true });
    }
    return { status: "verified" };
  });
  const deps: ReleasePostDependencies = {
    root: join(dataDir, "release-continuation", "post-release"),
    dataDir,
    receiptRoot,
    fence: {
      generation: 1,
      holder: "owner",
      assertCurrent: async () => undefined,
      retire: async () => undefined,
    },
    session: (id) => sessions.get(id) ?? null,
    complete,
    readTargetProof: async () => ({ status: "OK", type: "private", chatId: 77 }),
  };
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-primary-token");
  const send = vi.fn(async () =>
    Response.json({ ok: true, result: { message_id: 41, chat: { id: 77 } } }),
  );
  vi.stubGlobal("fetch", send);
  const run = (proof: VerifiedRelease | null = release) =>
    continueReleasePost(policy, "d".repeat(64), proof, deps);
  const journal = async () => {
    const names = (await readdir(deps.root)).filter(
      (name) => name.endsWith(".json") && !name.startsWith("task-"),
    );
    return {
      path: join(deps.root, names[0] ?? "missing"),
      value: JSON.parse(await readFile(join(deps.root, names[0] ?? "missing"), "utf8")) as {
        archive: { path: string; digest: string };
        cleanup: { sessionId: string; state: string }[];
        notification: {
          state: string;
          text: string;
          messageId: number;
          chatId: number;
          retryAt: number;
        };
        release: VerifiedRelease;
      },
    };
  };
  return {
    root,
    policy,
    release,
    deps,
    sessions,
    complete,
    calls,
    send,
    run,
    journal,
    worktree,
    artifacts,
  };
}
test("archive before deletion, reviewers/children before worker, one truthful Russian report", async () => {
  const f = await fixture();
  expect(await f.run()).toEqual({ complete: true, reason: "released-cleaned-reported" });
  expect(f.calls[0]).toBe("child");
  expect(f.calls.at(-1)).toBe("worker");
  expect(f.calls).toContain("predecessor");
  const { value } = await f.journal();
  expect(value.notification.text.split("\n")).toHaveLength(4);
  expect(value.notification.messageId).toBe(41);
  expect(value.notification.chatId).toBe(77);
  expect(await readFile(value.archive.path, "utf8")).not.toContain("worker-launch");
  expect(f.send).toHaveBeenCalledTimes(1);
});
test("duplicate release/later version/restart after worker and worktree removal reuse first tuple", async () => {
  const f = await fixture();
  await f.run();
  f.sessions.clear();
  expect((await f.run(null)).complete).toBe(true);
  expect(
    (
      await f.run({
        ...f.release,
        version: "1.2.4",
        gitHead: "e".repeat(40),
        deploymentDigest: "f".repeat(64),
      })
    ).complete,
  ).toBe(true);
  expect(f.complete).toHaveBeenCalledTimes(5);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect((await f.journal()).value.release.version).toBe("1.2.3");
});
test("archive failure prevents every destructive action and reports retained resources", async () => {
  const f = await fixture();
  await rm(join(f.root, "history.json"));
  expect((await f.run()).complete).toBe(false);
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect((await f.journal()).value.notification.text).toContain("release-archive-unverified");
});
test("actual durable failure and repair outcomes survive restart with frozen uncertain report", async () => {
  const f = await fixture();
  f.deps.flowOutcomes = [
    "reviewer-qa-environment-repair-required",
    "reviewer-fresh-generation-pending",
    "published-deployment-verified",
  ];
  f.send.mockRejectedValue(new Error("uncertain delivery"));
  expect((await f.run()).reason).toBe("telegram-dispatch-uncertain");
  const text = (await f.journal()).value.notification.text;
  expect(text).toContain(
    "reviewer-qa-environment-repair-required → reviewer-fresh-generation-pending",
  );
  f.deps.flowOutcomes = ["later-state"];
  await f.run(null);
  expect((await f.journal()).value.notification.text).toBe(text);
  expect(f.send).toHaveBeenCalledTimes(1);
});
test("crash after task index but before journal resumes original release without duplicate effects", async () => {
  const f = await fixture();
  let assertions = 0;
  f.deps.fence.assertCurrent = async () => {
    if (++assertions === 2) throw new Error("interrupted-before-journal");
  };
  await expect(f.run()).rejects.toThrow("interrupted-before-journal");
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  f.deps.fence.assertCurrent = async () => undefined;
  expect((await f.run(null)).complete).toBe(true);
  expect(f.send).toHaveBeenCalledTimes(1);
  await f.run(null);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect((await f.journal()).value.release.version).toBe("1.2.3");
});
test("cleanup failure/outstanding ledger remain honest; other members proceed and report partial", async () => {
  const f = await fixture();
  f.complete.mockImplementation(async (id) => {
    f.calls.push(id);
    if (id === "browser") throw new Error("todo_open_work");
    return { status: "verified" };
  });
  expect((await f.run()).complete).toBe(false);
  expect(f.calls).toContain("worker");
  expect(f.calls).toContain("predecessor");
  expect((await f.journal()).value.notification.text).toContain("lifecycle-blocked");
  expect(f.send).toHaveBeenCalledTimes(1);
  f.complete.mockResolvedValue({ status: "verified" });
  expect((await f.run(null)).complete).toBe(true);
  expect(f.send).toHaveBeenCalledTimes(1);
});
test("new unrelated task after archive cannot be completed", async () => {
  const f = await fixture();
  f.complete.mockImplementation(async (id) => {
    f.calls.push(id);
    if (id === "child") {
      const worker = f.sessions.get("worker");
      if (worker) worker.prompt = "new unrelated task";
    }
    return { status: "verified" };
  });
  expect((await f.run()).complete).toBe(false);
  expect(f.calls).not.toContain("worker");
  expect((await f.journal()).value.notification.text).toContain("release-task-changed");
});
test.each(["timeout", "5xx", "wrong-chat", "malformed"])(
  "Telegram %s dispatch uncertainty survives restart with no resend",
  async (mode) => {
    const f = await fixture();
    f.send.mockImplementation(async () => {
      if (mode === "timeout") throw new Error("timeout");
      if (mode === "5xx")
        return Response.json(
          { ok: false, error_code: 503, description: "failure" },
          { status: 503 },
        );
      if (mode === "wrong-chat")
        return Response.json({ ok: true, result: { message_id: 99, chat: { id: 88 } } });
      return Response.json({ result: { message_id: 99, chat: { id: 77 } } });
    });
    expect((await f.run()).reason).toBe("telegram-dispatch-uncertain");
    expect((await f.run(null)).reason).toBe("telegram-dispatch-uncertain");
    expect(f.send).toHaveBeenCalledTimes(1);
  },
);
test("429 proven rejection waits then reuses exact report text once", async () => {
  const f = await fixture();
  f.send.mockResolvedValueOnce(
    Response.json(
      { ok: false, error_code: 429, description: "rate limit", parameters: { retry_after: 2 } },
      { status: 429 },
    ),
  );
  expect((await f.run()).complete).toBe(false);
  expect((await f.run(null)).complete).toBe(false);
  expect(f.send).toHaveBeenCalledTimes(1);
  const { value } = await f.journal(),
    clock = vi.spyOn(Date, "now").mockReturnValue(value.notification.retryAt + 1);
  try {
    expect((await f.run(null)).complete).toBe(true);
  } finally {
    clock.mockRestore();
  }
  expect(f.send).toHaveBeenCalledTimes(2);
  expect((await f.journal()).value.notification.text).toBe(value.notification.text);
});
test("persisted send intent without response becomes uncertain before any call", async () => {
  const f = await fixture();
  await f.run();
  const { path, value } = await f.journal();
  value.notification.state = "intent";
  await writeFile(path, JSON.stringify(value));
  f.send.mockClear();
  expect((await f.run(null)).reason).toBe("telegram-dispatch-uncertain");
  expect(f.send).not.toHaveBeenCalled();
});
test("resume without verified release journal never cleans or sends", async () => {
  const f = await fixture();
  await expect(f.run(null)).rejects.toThrow("verified-journal-missing");
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});

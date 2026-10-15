import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as filesystem from "node:fs/promises";
import {
  claimContinuation,
  parseContinuationRecord,
  parseReviewerRestore,
  readReviewerRecovery,
  saveContinuationRecord,
  type ClaimProbes,
  type ReviewerRestoreFence,
} from "../../src/release-continuation-state.js";
import { createTempDir } from "../helpers/common.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    open: vi.fn(actual.open),
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
  vi.mocked(filesystem.writeFile).mockReset().mockImplementation(actual.writeFile);
  vi.mocked(filesystem.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(filesystem.open).mockReset().mockImplementation(actual.open);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function restoreFence(): ReviewerRestoreFence {
  return {
    repository: "owner/repo",
    PR: 4,
    lane: "browser",
    session: "browser-session",
    taskDigest: "1".repeat(64),
    authorityGeneration: 1,
    H: "a".repeat(40),
    B: "b".repeat(40),
    launchDigest: "2".repeat(64),
    nativeId: null,
    operationId: "restore-operation",
    budgetKey: "3".repeat(64),
    attempt: 1,
    attemptedAt: 100,
    deadline: 60_100,
    prerequisiteDigest: "4".repeat(64),
    instanceId: "service-instance",
    phase: "intent",
    denial: null,
    capacity: { enabled: true, cap: 2, liveCount: 2 },
  };
}
test.each(["lane", "budget", "receipt", "attempt", "head", "deadline"])(
  "reviewer restore parser rejects malformed %s before action",
  (mode) => {
    const proof: Record<string, unknown> = { ...restoreFence() };
    if (mode === "lane") proof.lane = "author";
    if (mode === "budget") proof.budgetKey = "../different";
    if (mode === "receipt") proof.phase = "zero-denied";
    if (mode === "attempt") proof.attempt = 4;
    if (mode === "head") proof.H = "not-a-commit";
    if (mode === "deadline") proof.deadline = 0;
    expect(() => parseReviewerRestore(proof)).toThrow();
  },
);
test("reviewer stable fence and budget survive actual state reload, mismatched target stays invalid", async () => {
  const directory = await root();
  const fence = restoreFence();
  const record = {
    version: 1,
    authorityGeneration: 1,
    invocation: "current",
    H: fence.H,
    B: fence.B,
    reason: "pending",
    affirmations: {},
    actions: [],
    mergeSha: null,
    publishedProofDigest: null,
    reviewerRestores: { browser: fence },
  };
  expect(parseContinuationRecord(record).reviewerRestores?.browser).toEqual(fence);
  expect(() => parseContinuationRecord({ ...record, reviewerRestores: { code: fence } })).toThrow();
  const path = join(directory, "budget.json");
  const budget = {
    key: fence.budgetKey,
    attempts: 1,
    attemptedAt: 100,
    launch: fence.launchDigest,
    state: "blocked",
    reason: "pending",
    source: "",
    actions: [],
    prerequisite: null,
    restoreAttempts: [fence],
  };
  await writeFile(path, JSON.stringify(budget));
  expect((await readReviewerRecovery(path, fence.budgetKey))?.restoreAttempts).toEqual([fence]);
  await writeFile(path, JSON.stringify({ ...budget, attempts: 0 }));
  await expect(readReviewerRecovery(path, fence.budgetKey)).rejects.toThrow("recovery-invalid");
});
test("reviewer proof publication flushes file then rename and directory before returning", async () => {
  const directory = await root();
  const owner = await claimContinuation(join(directory, "new", "parents", "owners"), live);
  const sequence: string[] = [];
  const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
  const write = actual.writeFile,
    rename = actual.rename,
    open = actual.open;
  vi.spyOn(filesystem, "writeFile").mockImplementation(async (file, data, options) => {
    if (typeof options === "object" && options !== null && "flush" in options && options.flush)
      sequence.push("flush");
    await write(file, data, options);
  });
  vi.spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    sequence.push("rename");
  });
  vi.spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode),
      sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      await sync();
      sequence.push("directory-sync");
    });
    return handle;
  });
  const record = parseContinuationRecord({
    version: 1,
    authorityGeneration: 1,
    invocation: "current",
    H: "a".repeat(40),
    B: "b".repeat(40),
    reason: "pending",
    affirmations: {},
    actions: [],
    mergeSha: null,
    publishedProofDigest: null,
    reviewerRestores: { browser: restoreFence() },
  });
  await saveContinuationRecord(join(directory, "proof.json"), record, owner);
  expect(sequence).toEqual(["flush", "rename", "directory-sync"]);
});
async function root(): Promise<string> {
  const path = await createTempDir("release-claims-");
  roots.push(path);
  return path;
}
const live: ClaimProbes = {
  boot: async () => "boot",
  process: async () => ({ kind: "ok", starttime: 12, state: "R" }),
};
test("live owner and unknown process never expire into takeover", async () => {
  const path = await root();
  const first = await claimContinuation(path, live);
  await expect(claimContinuation(path, live)).rejects.toThrow("owner-live");
  let reads = 0;
  await expect(
    claimContinuation(path, {
      ...live,
      process: async () =>
        ++reads === 1 ? { kind: "ok", starttime: 12, state: "R" } : { kind: "unknown" },
    }),
  ).rejects.toThrow("identity-unknown");
  await first.retire();
  const next = await claimContinuation(path, live);
  expect(next.generation).toBe(2);
  await expect(first.assertCurrent()).rejects.toThrow("fenced");
  await expect(first.retire()).rejects.toThrow("fenced");
  await next.assertCurrent();
});
test.each(["gone", "reuse", "reboot", "zombie"])(
  "confirmed %s permits immutable successor",
  async (mode) => {
    const path = await root();
    await claimContinuation(path, live);
    let reads = 0;
    const next = await claimContinuation(path, {
      boot: async () => (mode === "reboot" ? "next-boot" : "boot"),
      process: async () => {
        if (++reads === 1) return { kind: "ok", starttime: 99, state: "R" };
        if (mode === "gone") return { kind: "gone" };
        return {
          kind: "ok",
          starttime: mode === "reuse" ? 99 : 12,
          state: mode === "zombie" ? "Z" : "R",
        };
      },
    });
    expect(next.generation).toBe(2);
    expect(JSON.parse(await readFile(join(path, "1.claim"), "utf8"))).toMatchObject({
      generation: 1,
      starttime: 12,
    });
  },
);
test("staging debris is ignored; published corruption blocks", async () => {
  const path = await root();
  await writeFile(join(path, "dead.stage"), "");
  await claimContinuation(path, live);
  await writeFile(join(path, "1.claim"), "");
  await expect(claimContinuation(path, live)).rejects.toThrow("claim-invalid");
});
test("simultaneous same-generation successors publish one complete holder", async () => {
  const path = await root();
  await mkdir(join(path, "unused"));
  const outcomes = await Promise.allSettled([
    claimContinuation(path, live),
    claimContinuation(path, live),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  const claim: unknown = JSON.parse(await readFile(join(path, "1.claim"), "utf8"));
  expect(claim).toMatchObject({
    generation: 1,
    predecessor: null,
    boot: "boot",
    pid: process.pid,
    starttime: 12,
  });
});

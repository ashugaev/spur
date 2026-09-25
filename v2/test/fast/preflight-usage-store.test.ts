import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreflightUsageStore } from "../../src/preflight-usage-store.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function store(): Promise<PreflightUsageStore> {
  const directory = await mkdtemp(join(tmpdir(), "spur-preflight-ledger-test-"));
  directories.push(directory);
  return new PreflightUsageStore(directory);
}

describe("PreflightUsageStore", () => {
  it("accepts a client-minted batch before the first preview and rejects cross-project reuse", async () => {
    const ledger = await store();
    const id = randomUUID();
    await expect(ledger.resolve("api", id)).resolves.toBe(id);
    await expect(ledger.resolve("api", id)).resolves.toBe(id);
    await expect(ledger.resolve("other", id)).rejects.toThrow("project mismatch");
    await expect(ledger.resolve("api", "not-a-uuid")).rejects.toThrow("invalid preflightBatchId");
  });

  it("rejects corrupt requested batches without overwriting their evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spur-preflight-corrupt-test-"));
    directories.push(directory);
    const ledger = new PreflightUsageStore(directory);
    const id = randomUUID();
    const path = join(directory, "preflight-batches", `${id}.json`);
    await mkdir(join(directory, "preflight-batches"));
    await writeFile(path, "{corrupt", "utf8");
    await expect(ledger.resolve("api", id)).rejects.toThrow("Corrupt preflight batch");
    expect(await readFile(path, "utf8")).toBe("{corrupt");
  });

  it("does not prune a batch while its paid attempt is in flight", async () => {
    const ledger = await store();
    const batch = await ledger.create("api");
    let finish: (() => void) | undefined;
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const attempt = ledger.runAttempt(batch, "api", "claude", async () => {
      started?.();
      await pending;
      return { usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } };
    });
    await entered;
    const future = Date.now() + 31 * 24 * 60 * 60 * 1_000;
    const prune = ledger.prune(future);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(future);
    finish?.();
    await attempt;
    await prune;
    await expect(ledger.view(batch, "api")).resolves.toMatchObject({ totalTokens: 5 });
  });

  it("recovers a crash-left started attempt as unknown without billing zero", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spur-preflight-crash-test-"));
    directories.push(directory);
    const id = randomUUID();
    await mkdir(join(directory, "preflight-batches"));
    await writeFile(
      join(directory, "preflight-batches", `${id}.json`),
      JSON.stringify({
        version: 1,
        id,
        project: "api",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        attempts: [
          {
            sequence: 1,
            provider: "claude",
            startedAt: "2026-01-01T00:00:00.000Z",
            outcome: "started",
            providerIterationCount: 1,
          },
        ],
      }),
      "utf8",
    );
    const restarted = new PreflightUsageStore(directory);
    await expect(restarted.view(id, "api")).resolves.toEqual({
      status: "unknown",
      attemptCount: 1,
      unknownAttemptCount: 1,
      providerIterationCount: 1,
    });
  });

  it("expires an abandoned batch after 30 days", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spur-preflight-expiry-test-"));
    directories.push(directory);
    const ledger = new PreflightUsageStore(directory);
    const id = await ledger.create("api");
    await ledger.prune(Date.now() + 31 * 24 * 60 * 60 * 1_000);
    await expect(ledger.view(id, "api")).rejects.toThrow("Unknown preflight batch");
  });

  it("serializes mixed-provider attempts and claims the aggregate once", async () => {
    const ledger = await store();
    const batch = await ledger.create("api");
    await Promise.all([
      ledger.runAttempt(batch, "api", "claude", async () => ({
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        providerIterationCount: 2,
      })),
      ledger.runAttempt(batch, "api", "codex", async () => ({
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      })),
    ]);

    const claimed = await ledger.claim(batch, "api", "api-1");
    expect(claimed).toMatchObject({
      status: "measured",
      attemptCount: 2,
      unknownAttemptCount: 0,
      providerIterationCount: 3,
      inputTokens: 30,
      outputTokens: 15,
      totalTokens: 45,
    });
    await expect(ledger.claim(batch, "api", "api-1")).resolves.toEqual(claimed);
    await expect(ledger.claim(batch, "api", "api-2")).rejects.toThrow("claimed by another session");
  });

  it("preserves explicit measured zero and terminal unknown separately", async () => {
    const ledger = await store();
    const zeroBatch = await ledger.create("api");
    await ledger.runAttempt(zeroBatch, "api", "cursor", async () => ({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }));
    await expect(ledger.view(zeroBatch, "api")).resolves.toMatchObject({
      status: "measured",
      totalTokens: 0,
    });

    const unknownBatch = await ledger.create("api");
    await ledger.runAttempt(unknownBatch, "api", "claude", async () => ({}));
    await expect(ledger.view(unknownBatch, "api")).resolves.toEqual({
      status: "unknown",
      attemptCount: 1,
      unknownAttemptCount: 1,
      providerIterationCount: 1,
    });
  });
});

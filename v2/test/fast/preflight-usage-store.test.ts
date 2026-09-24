import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreflightUsageStore } from "../../src/preflight-usage-store.js";

const directories: string[] = [];

afterEach(async () => {
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

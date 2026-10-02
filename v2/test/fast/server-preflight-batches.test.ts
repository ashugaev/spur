import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startServer } from "../../src/server.js";
import { findFreePort } from "../helpers/common.js";

it("allocates a fresh measured preflight batch over HTTP and rejects unknown projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "spur-preflight-http-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const port = await findFreePort();
  const config = join(root, "spur.yaml");
  await writeFile(
    config,
    `server:\n  host: 127.0.0.1\n  port: ${port}\ndataDir: ${join(root, "data")}\nworktreeDir: ${join(root, "worktrees")}\nprojects:\n  demo:\n    path: ${repo}\n`,
  );
  const server = await startServer(config, { info: () => undefined, warn: () => undefined });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/projects/demo/preflight-batches`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const batch = (await response.json()) as { preflightBatchId: string };
    expect(batch.preflightBatchId).toMatch(/^[0-9a-f-]{36}$/);
    const preview = await fetch(`http://127.0.0.1:${port}/projects/demo/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello", preflightBatchId: batch.preflightBatchId }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      preflightBatchId: batch.preflightBatchId,
      preflightTokenUsageView: { status: "measured", attemptCount: 0, totalTokens: 0 },
    });
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/projects/missing/preflight-batches`, {
          method: "POST",
        })
      ).status,
    ).toBe(404);
  } finally {
    await server.stop();
  }
});

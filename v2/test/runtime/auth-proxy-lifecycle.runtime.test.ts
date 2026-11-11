import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AuthAccounts } from "../../src/auth-accounts.js";
import { AuthProxy, authProxyBinaryPath } from "../../src/auth-proxy.js";
import { findFreePort } from "../helpers/common.js";

describe("native companion control lifecycle", () => {
  const proxies: AuthProxy[] = [];
  let directory: string | undefined;
  let endpoint: string | undefined;

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) proxy.dispose();
    if (endpoint) {
      await expect
        .poll(
          async () => {
            try {
              await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(500) });
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 7_000 },
        )
        .toBe(true);
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("hydrates the saved endpoint, routing key and episode across control-parent replacement", async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "spur-auth-process-")));
    const accounts = new AuthAccounts(directory, () => true);
    const account = accounts.add("codex", "Fixture");
    endpoint = `http://127.0.0.1:${await findFreePort()}`;
    const token = "ab".repeat(32);
    const session = {
      sessionId: "survivor",
      provider: "codex",
      mode: "pinned",
      accountId: account.id,
      effectiveAccountId: account.id,
      generation: 1,
    };
    const saved = {
      schema: 1,
      dataDir: directory,
      endpoint,
      sessions: {
        survivor: {
          session,
          token,
          defaultGeneration: 0,
          episode: { open: true, rotations: 1, epoch: 1 },
        },
      },
      cooldowns: {},
    };
    const statePath = join(directory, "auth-proxy-state.json");
    await writeFile(statePath, JSON.stringify(saved), { mode: 0o600 });
    const make = () => {
      const proxy = new AuthProxy(
        directory!,
        () => ({
          state: accounts.read(),
          policy: { cooldownMinutes: 60, maxRotationsPerEpisode: 2 },
        }),
        () => process.env["SPUR_AUTH_PROXY_TEST_BINARY"] ?? authProxyBinaryPath(),
      );
      proxies.push(proxy);
      return proxy;
    };
    const first = make();
    await first.recover();
    expect((await first.getState()).sessions).toEqual([session]);
    expect(
      (await fetch(`${endpoint}/v1/models`, { headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(503);
    expect(
      (await fetch(`${endpoint}/v1/models`, { headers: { authorization: "Bearer unknown" } }))
        .status,
    ).toBe(401);
    await expect(
      first.registerSession({ sessionId: "unready", provider: "codex", accountId: account.id }),
    ).rejects.toThrow();

    first.dispose();
    const second = make();
    await second.recover();
    expect((await second.getState()).sessions).toEqual([session]);
    expect(
      (await fetch(`${endpoint}/v1/models`, { headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(503);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      throw new Error("Invalid companion lifecycle fixture state", { cause: error });
    }
    expect(
      z
        .object({
          endpoint: z.string(),
          sessions: z.object({
            survivor: z.object({ token: z.string(), episode: z.object({ rotations: z.number() }) }),
          }),
        })
        .parse(raw),
    ).toEqual({
      endpoint,
      sessions: { survivor: { token, episode: { rotations: 1 } } },
    });
  });
});

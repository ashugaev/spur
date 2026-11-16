import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProxy } from "../../src/auth-proxy.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("authorization proxy private control", () => {
  let proxy: AuthProxy | undefined;

  afterEach(() => {
    proxy?.dispose();
    vi.restoreAllMocks();
  });

  function childWithControl(
    handle: (
      request: { id: number; method: string },
      output: PassThrough,
      done: (error?: Error) => void,
    ) => void,
  ) {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new Writable({
        write(chunk: Buffer, _encoding, done) {
          const request = JSON.parse(chunk.toString()) as { id: number; method: string };
          handle(request, child.stdout, done);
        },
      }),
      kill: vi.fn(() => {
        child.emit("close", 1);
        return true;
      }),
    });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() =>
        child.stdout.write('{"event":"ready","endpoint":"http://127.0.0.1:45678"}\n'),
      );
      return child as unknown as ReturnType<typeof spawn>;
    });
    proxy = new AuthProxy(
      "/fixture",
      () => ({
        state: { schema: 1, accounts: [], pools: {} },
        policy: { cooldownMinutes: 60, maxRotationsPerEpisode: 2 },
      }),
      () => "/fixture/auth-proxy",
      onRotated,
    );
    return child;
  }

  const onRotated = vi.fn();

  it("forwards companion rotation events without treating them as responses", async () => {
    childWithControl((request, output, done) => {
      if (request.method === "getState") {
        output.write(
          '{"event":"rotated","sessionId":"s-1","provider":"codex","fromAccountId":"a","toAccountId":"b","generation":3}\n',
        );
      }
      const result = request.method === "configure" ? {} : { accounts: [], sessions: [] };
      output.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      done();
    });
    await expect(proxy!.getState()).resolves.toEqual({ accounts: [], sessions: [] });
    expect(onRotated).toHaveBeenCalledExactlyOnceWith({
      sessionId: "s-1",
      provider: "codex",
      fromAccountId: "a",
      toAccountId: "b",
      generation: 3,
    });
  });

  it("BrokenControlPipe rejects pending work without an unhandled stream error", async () => {
    const child = childWithControl((request, output, done) => {
      if (request.method === "configure") {
        output.write(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
        done();
      } else {
        done(Object.assign(new Error("closed pipe"), { code: "EPIPE" }));
      }
    });
    await expect(proxy!.getState()).rejects.toThrow("disconnected");
    await setImmediate();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("validates account summaries and strips unexpected secret fields", async () => {
    childWithControl((request, output, done) => {
      const result =
        request.method === "configure"
          ? {}
          : {
              accounts: [{ id: "a", provider: "claude", status: "ready", accessToken: "secret" }],
              sessions: [],
            };
      output.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
      done();
    });
    expect(await proxy!.getState()).toEqual({
      accounts: [{ id: "a", provider: "claude", status: "ready" }],
      sessions: [],
    });
  });

  it("rejects malformed provider output instead of treating files as ready", async () => {
    childWithControl((request, output, done) => {
      output.write(
        `${JSON.stringify({ id: request.id, ok: true, result: request.method === "configure" ? {} : { accounts: [{ id: "a", provider: "claude", status: "file-exists" }], sessions: [] } })}\n`,
      );
      done();
    });
    await expect(proxy!.getState()).rejects.toThrow();
  });

  const reply = (
    output: PassThrough,
    request: { id: number; method: string },
    result: unknown,
  ): void => {
    const value = request.method === "configure" ? {} : result;
    output.write(`${JSON.stringify({ id: request.id, ok: true, result: value })}\n`);
  };

  it("parses method, stage, errorCode, busy and brokenAt; rejects unknown values", async () => {
    let next: unknown;
    childWithControl((request, output, done) => {
      reply(output, request, next);
      done();
    });
    next = {
      accountId: "a",
      status: "failed",
      method: "api_key",
      stage: "verifying",
      errorCode: "key_rejected",
      error: "Rejected",
    };
    await expect(proxy!.loginStatus("a")).resolves.toEqual(next);
    for (const [errorCode, error] of [
      ["code_rejected", "Provider rejected the sign-in code (HTTP 400)"],
      ["provider_blocked", "Provider blocked the sign-in request (HTTP 403)"],
    ] as const) {
      next = { accountId: "a", status: "failed", errorCode, error };
      await expect(proxy!.loginStatus("a")).resolves.toEqual(next);
    }
    next = { accountId: "a", status: "busy" };
    await expect(proxy!.importNativeLogin("a", "claude")).resolves.toEqual(next);
    next = {
      accounts: [
        {
          id: "a",
          provider: "codex",
          status: "sign-in-required",
          credential: "api_key",
          brokenAt: "2026-11-16T10:00:00Z",
        },
      ],
      sessions: [],
    };
    await expect(proxy!.getState()).resolves.toEqual(next);
    for (const bad of [
      { accountId: "a", status: "ready", errorCode: "boom" },
      { accountId: "a", status: "ready", stage: "done" },
      { accountId: "a", status: "ready", method: "magic" },
      { accountId: "a", status: "waiting" },
    ]) {
      next = bad;
      await expect(proxy!.loginStatus("a")).rejects.toThrow();
    }
    next = {
      accounts: [{ id: "a", provider: "claude", status: "busy" }],
      sessions: [],
    };
    await expect(proxy!.getState()).rejects.toThrow();
  });

  it("sends login method, setApiKey and importNativeLogin as typed requests", async () => {
    const sent: unknown[] = [];
    childWithControl((request, output, done) => {
      if (request.method !== "configure") sent.push(request);
      reply(output, request, { accountId: "a", status: "pending" });
      done();
    });
    await proxy!.login("a", "codex", "browser");
    await proxy!.setApiKey("a", "claude", "sk-fixture-key");
    await proxy!.importNativeLogin("a", "codex");
    expect(sent).toEqual([
      {
        id: expect.any(Number),
        method: "login",
        params: { accountId: "a", provider: "codex", method: "browser" },
      },
      {
        id: expect.any(Number),
        method: "setApiKey",
        params: { accountId: "a", provider: "claude", apiKey: "sk-fixture-key" },
      },
      {
        id: expect.any(Number),
        method: "importNativeLogin",
        params: { accountId: "a", provider: "codex" },
      },
    ]);
  });
});

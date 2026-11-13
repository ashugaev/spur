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
    );
    return child;
  }

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
});

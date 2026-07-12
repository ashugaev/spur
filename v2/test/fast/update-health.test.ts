import { describe, expect, it } from "vitest";
import {
  makeTargets,
  probeWith,
  resolveWebPort,
  type FetchLike,
} from "../../src/update-health.js";

describe("resolveWebPort", () => {
  it("defaults to 4311 when no PORT environment line is present", () => {
    expect(resolveWebPort("[Service]\nExecStart=/usr/bin/node server.js\n")).toBe(4311);
  });

  it("reads a single Environment=PORT line", () => {
    expect(resolveWebPort("[Service]\nEnvironment=PORT=5000\n")).toBe(5000);
  });

  it("lets the last Environment=PORT line win", () => {
    const contents = [
      "[Service]",
      "Environment=PORT=5000",
      "ExecStart=/usr/bin/node server.js",
      "Environment=PORT=6200",
    ].join("\n");
    expect(resolveWebPort(contents)).toBe(6200);
  });
});

describe("makeTargets", () => {
  it("builds daemon, web, and terminal probe URLs", () => {
    const targets = makeTargets(6200);
    expect(targets.daemon.url).toBe("http://127.0.0.1:4310/sessions");
    expect(targets.web.url).toBe("http://127.0.0.1:6200/");
    expect(targets.terminal.url).toBe("http://127.0.0.1:14801/health");
  });
});

describe("probeWith", () => {
  const target = { id: "daemon" as const, url: "http://127.0.0.1:4310/sessions" };

  it("maps a 2xx response to ok", async () => {
    const fetchLike: FetchLike = async () => ({ ok: true });
    expect(await probeWith(fetchLike, target)).toEqual({ ok: true });
  });

  it("maps a non-2xx response to http-error", async () => {
    const fetchLike: FetchLike = async () => ({ ok: false });
    expect(await probeWith(fetchLike, target)).toEqual({ ok: false, reason: "http-error" });
  });

  it("maps a thrown ECONNREFUSED to connection-refused", async () => {
    const fetchLike: FetchLike = () => {
      const error = new TypeError("fetch failed");
      (error as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      return Promise.reject(error);
    };
    expect(await probeWith(fetchLike, target)).toEqual({
      ok: false,
      reason: "connection-refused",
    });
  });

  it("maps an abort/timeout to timeout", async () => {
    const fetchLike: FetchLike = () => {
      const error = new Error("The operation was aborted");
      error.name = "TimeoutError";
      return Promise.reject(error);
    };
    expect(await probeWith(fetchLike, target)).toEqual({ ok: false, reason: "timeout" });
  });

  it("maps an arbitrary/unknown transport error to the neutral unknown bucket", async () => {
    const fetchLike: FetchLike = () => Promise.reject(new Error("socket hang up"));
    expect(await probeWith(fetchLike, target)).toEqual({ ok: false, reason: "unknown" });
  });
});

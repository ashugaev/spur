import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir } from "../helpers/common.js";
import {
  DEFAULT_DAEMON_PORT,
  makeTargets,
  parseWebUnitOptions,
  probeInfoWith,
  probeWith,
  resolveDaemonPort,
  resolveDaemonPortReadOnly,
  resolveWebPort,
  type FetchLike,
  type JsonFetchLike,
} from "../../src/update-health.js";

const tempDirs: string[] = [];
const initialSpurConfig = process.env["SPUR_CONFIG"];

afterEach(async () => {
  if (initialSpurConfig === undefined) {
    delete process.env["SPUR_CONFIG"];
  } else {
    process.env["SPUR_CONFIG"] = initialSpurConfig;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Regression guard for the doctor read-only invariant: `spur doctor` must
// never bootstrap `~/.spur/config.yaml` (or any pinned instance config) on a
// host that has never run any Spur command before. This file never imports
// `host-install.ts`, so it cannot catch a regression there — the real guard
// for that invariant is the runtime test "doctor --json without --scaffold
// never creates spur.yaml or the global/pinned instance config on a
// never-initialized host" in `cli-lifecycle.runtime.test.ts`. This describe
// block only pins `resolveDaemonPortReadOnly`/`resolveDaemonPort`'s own
// bootstrap-vs-no-bootstrap behavior in isolation.
describe("resolveDaemonPortReadOnly vs resolveDaemonPort (read-only invariant)", () => {
  it("resolveDaemonPortReadOnly never creates the pinned instance config, and falls back to the default port", async () => {
    const dir = await createTempDir("spur-daemon-port-readonly-");
    tempDirs.push(dir);
    const configPath = join(dir, "does-not-exist.yaml");
    process.env["SPUR_CONFIG"] = configPath;

    const port = resolveDaemonPortReadOnly();

    expect(port).toBe(DEFAULT_DAEMON_PORT);
    expect(existsSync(configPath)).toBe(false);
  });

  it("resolveDaemonPort DOES bootstrap-create the pinned instance config when it is missing", async () => {
    const dir = await createTempDir("spur-daemon-port-write-");
    tempDirs.push(dir);
    const configPath = join(dir, "does-not-exist.yaml");
    process.env["SPUR_CONFIG"] = configPath;

    const port = resolveDaemonPort();

    expect(port).toBe(DEFAULT_DAEMON_PORT);
    expect(existsSync(configPath)).toBe(true);
  });
});

describe("resolveWebPort", () => {
  it("defaults to 5555 when no PORT environment line is present", () => {
    expect(resolveWebPort("[Service]\nExecStart=/usr/bin/node server.js\n")).toBe(5555);
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

describe("parseWebUnitOptions", () => {
  it("returns the default loopback:5555 config for a bare unit", () => {
    expect(parseWebUnitOptions("[Service]\nExecStart=/usr/bin/node server.js\n")).toEqual({
      webPort: 5555,
      exposeWeb: false,
      tailscale: false,
    });
  });

  it("derives a custom port and external exposure from the live unit", () => {
    const contents = [
      "[Service]",
      "Environment=PORT=6200",
      "Environment=WEB_HOST=0.0.0.0",
      "ExecStart=/usr/bin/node server.js",
    ].join("\n");
    expect(parseWebUnitOptions(contents)).toEqual({
      webPort: 6200,
      exposeWeb: true,
      tailscale: false,
    });
  });

  it("does not flag loopback WEB_HOST as exposed", () => {
    const contents = "[Service]\nEnvironment=PORT=6200\nEnvironment=WEB_HOST=127.0.0.1\n";
    expect(parseWebUnitOptions(contents)).toEqual({
      webPort: 6200,
      exposeWeb: false,
      tailscale: false,
    });
  });

  it("flags a comma-separated WEB_HOST as a live Tailscale bind", () => {
    const contents =
      "[Service]\nEnvironment=PORT=6200\nEnvironment=WEB_HOST=127.0.0.1,100.64.0.1\n";
    expect(parseWebUnitOptions(contents)).toEqual({
      webPort: 6200,
      exposeWeb: false,
      tailscale: true,
    });
  });

  it("recognizes a legacy pre-#573 HOSTNAME=0.0.0.0 exposure so update does not downgrade it", () => {
    const contents = [
      "[Service]",
      "Environment=PORT=6200",
      "Environment=HOSTNAME=0.0.0.0",
      "ExecStart=/usr/bin/node server.js",
    ].join("\n");
    expect(parseWebUnitOptions(contents)).toEqual({
      webPort: 6200,
      exposeWeb: true,
      tailscale: false,
    });
  });
});

describe("makeTargets", () => {
  it("builds daemon and web probe URLs from the resolved ports", () => {
    const targets = makeTargets({ daemon: 4310, web: 6200 });
    expect(targets.daemon.url).toBe("http://127.0.0.1:4310/info");
    expect(targets.web.url).toBe("http://127.0.0.1:6200/");
  });

  it("honors a non-default daemon port so a custom server.port host is probed correctly", () => {
    const targets = makeTargets({ daemon: 5310, web: 4311 });
    expect(targets.daemon.url).toBe("http://127.0.0.1:5310/info");
  });
});

describe("probeWith", () => {
  const target = { id: "daemon" as const, url: "http://127.0.0.1:4310/info" };

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

describe("probeInfoWith", () => {
  const target = { id: "daemon" as const, url: "http://127.0.0.1:4310/info" };

  it("returns the version from a well-formed JSON body", async () => {
    const fetchLike: JsonFetchLike = async () => ({
      ok: true,
      json: async () => ({ version: "1.2.3" }),
    });
    expect(await probeInfoWith(fetchLike, target)).toEqual({ ok: true, version: "1.2.3" });
  });

  it("reports http-error for a non-2xx response", async () => {
    const fetchLike: JsonFetchLike = async () => ({
      ok: false,
      json: async () => ({ version: "1.2.3" }),
    });
    expect(await probeInfoWith(fetchLike, target)).toEqual({ ok: false, reason: "http-error" });
  });

  it("reports the neutral unknown reason when the body is missing a string version field", async () => {
    const fetchLike: JsonFetchLike = async () => ({ ok: true, json: async () => ({}) });
    expect(await probeInfoWith(fetchLike, target)).toEqual({ ok: false, reason: "unknown" });
  });

  it("reports the neutral unknown reason when the body fails to parse as JSON", async () => {
    const fetchLike: JsonFetchLike = async () => ({
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });
    expect(await probeInfoWith(fetchLike, target)).toEqual({ ok: false, reason: "unknown" });
  });

  it("reports timeout on a timeout/abort", async () => {
    const fetchLike: JsonFetchLike = () => {
      const error = new Error("The operation was aborted");
      error.name = "TimeoutError";
      return Promise.reject(error);
    };
    expect(await probeInfoWith(fetchLike, target)).toEqual({ ok: false, reason: "timeout" });
  });
});

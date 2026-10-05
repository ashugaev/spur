import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publishIsolatedWebEndpoint,
  readIsolatedWebEndpoint,
  validateIsolatedDaemonReady,
  type IsolatedDaemonCandidate,
} from "../../src/isolated-web-endpoint.js";
import * as identity from "../../src/sidecars/reap.js";

const directories: string[] = [];
function parseReceipt(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error("Malformed fixture receipt", { cause: error });
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "spur-isolated-ui-receipt-"));
  directories.push(directory);
  const configPath = join(directory, "config.yaml");
  const filePath = join(directory, "ui-endpoint.json");
  await writeFile(configPath, "server: {port: 4321}\n", { mode: 0o600 });
  return { directory, configPath, filePath, port: 5642, pid: process.pid };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("owned isolated UI endpoint", () => {
  it("accepts exact ready daemon identity and rejects mismatched or changed generations", async () => {
    const args = await fixture();
    await writeFile(
      args.configPath,
      `server: {host: 127.0.0.1, port: 4321}\ndataDir: ${args.directory}/data\ntmux: {socketName: fixture}\n`,
    );
    const starttime = await identity.readLiveProcessStarttime(process.pid);
    if (starttime === null) throw new Error("Missing fixture identity");
    const candidate: IsolatedDaemonCandidate = {
      configPath: args.configPath,
      filePath: args.filePath,
      dataDir: join(args.directory, "data"),
      baseUrl: "http://127.0.0.1:4321",
      socketName: "fixture",
      pid: process.pid,
      starttime,
    };
    const info = {
      ok: true,
      apiVersion: 3,
      pid: process.pid,
      host: "127.0.0.1",
      port: 4321,
      configPath: candidate.configPath,
      dataDir: candidate.dataDir,
      tmuxSocketName: candidate.socketName,
      lifecycleInstanceId: "generation-one",
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(info));
    vi.stubGlobal("fetch", fetchMock);
    expect(await validateIsolatedDaemonReady(candidate)).toBe("generation-one");
    expect(fetchMock).toHaveBeenCalledWith(`${candidate.baseUrl}/info`, {
      signal: expect.any(AbortSignal),
    });
    for (const update of [
      { ok: false },
      { apiVersion: 0 },
      { pid: process.pid + 1 },
      { host: "localhost" },
      { port: 4322 },
      { configPath: "/wrong/config" },
      { dataDir: "/wrong/data" },
      { tmuxSocketName: "wrong" },
      { lifecycleInstanceId: "" },
    ]) {
      fetchMock.mockResolvedValue(Response.json({ ...info, ...update }));
      expect(await validateIsolatedDaemonReady(candidate)).toBeNull();
    }
    fetchMock.mockResolvedValue(new Response("starting", { status: 503 }));
    expect(await validateIsolatedDaemonReady(candidate)).toBeNull();
    fetchMock.mockResolvedValue(new Response("{", { status: 200 }));
    expect(await validateIsolatedDaemonReady(candidate)).toBeNull();
    fetchMock.mockImplementation(() => Promise.resolve(Response.json(info)));
    expect(await validateIsolatedDaemonReady(candidate, "different-generation")).toBeNull();
    for (const update of [
      { dataDir: "/wrong" },
      { baseUrl: "http://127.0.0.1:5555" },
      { socketName: "wrong" },
      { starttime: starttime + 1 },
      { pid: 0 },
    ]) {
      fetchMock.mockClear();
      expect(await validateIsolatedDaemonReady({ ...candidate, ...update })).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    }
    const owner = vi.spyOn(identity, "readLiveProcessStarttime");
    owner.mockResolvedValueOnce(starttime).mockResolvedValueOnce(null);
    expect(await validateIsolatedDaemonReady(candidate)).toBeNull();
    expect(owner).toHaveBeenCalledTimes(2);
    owner.mockResolvedValue(null);
    fetchMock.mockClear();
    expect(await validateIsolatedDaemonReady(candidate)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("bounds each daemon request with a one-second abort", async () => {
    const args = await fixture();
    await writeFile(
      args.configPath,
      `server: {host: 127.0.0.1, port: 4321}\ndataDir: ${args.directory}/data\ntmux: {socketName: fixture}\n`,
    );
    const starttime = await identity.readLiveProcessStarttime(process.pid);
    if (starttime === null) throw new Error("Missing fixture identity");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const controller = new AbortController();
    timeout.mockReturnValue(controller.signal);
    let markStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((done) => {
      markStarted = done;
    });
    vi.stubGlobal(
      "fetch",
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_done, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
          markStarted?.();
        }),
    );
    const pending = validateIsolatedDaemonReady({
      configPath: args.configPath,
      filePath: args.filePath,
      dataDir: join(args.directory, "data"),
      baseUrl: "http://127.0.0.1:4321",
      socketName: "fixture",
      pid: process.pid,
      starttime,
    });
    await requestStarted;
    expect(timeout).toHaveBeenCalledWith(1000);
    controller.abort();
    expect(await pending).toBeNull();
  });
  it("publishes atomic private receipt, reads live owner and validates schema/instance", async () => {
    const args = await fixture();
    expect(await readIsolatedWebEndpoint(args.configPath, args.filePath)).toBeNull();
    await publishIsolatedWebEndpoint(args);
    expect((await lstat(args.filePath)).mode & 0o777).toBe(0o600);
    expect(await readIsolatedWebEndpoint(args.configPath, args.filePath)).toBe(
      "http://127.0.0.1:5642",
    );
    const original = parseReceipt(await readFile(args.filePath, "utf8"));
    for (const update of [
      { version: 2 },
      { port: 0 },
      { port: 65536 },
      { pid: 0 },
      { configPath: join(args.directory, "other.yaml") },
      { starttime: -1 },
    ]) {
      await writeFile(args.filePath, JSON.stringify({ ...original, ...update }));
      expect(await readIsolatedWebEndpoint(args.configPath, args.filePath)).toBeNull();
    }
    await writeFile(args.filePath, "{");
    expect(await readIsolatedWebEndpoint(args.configPath, args.filePath)).toBeNull();
  });
  it("rejects reused, zombie, dead or unreadable owner without removing receipt", async () => {
    const args = await fixture();
    await publishIsolatedWebEndpoint(args);
    const original = await readFile(args.filePath, "utf8");
    const live = await identity.readLiveProcessStarttime(args.pid);
    if (live === null) throw new Error("Missing live fixture identity");
    const probe = vi.spyOn(identity, "readLiveProcessStarttime");
    for (const starttime of [null, live + 1]) {
      probe.mockResolvedValue(starttime);
      expect(await readIsolatedWebEndpoint(args.configPath, args.filePath)).toBeNull();
      expect(await readFile(args.filePath, "utf8")).toBe(original);
    }
    probe.mockResolvedValue(null);
    await expect(publishIsolatedWebEndpoint(args)).rejects.toThrow("live owner");
  });
  it("rejects unsafe receipt, directory and symlink paths", async () => {
    const args = await fixture();
    await publishIsolatedWebEndpoint(args);
    await chmod(args.filePath, 0o644);
    expect(await readIsolatedWebEndpoint(args.configPath, args.filePath)).toBeNull();
    await expect(publishIsolatedWebEndpoint(args)).rejects.toThrow("Unsafe");
    await rm(args.filePath);
    await symlink(args.configPath, args.filePath);
    expect(await readIsolatedWebEndpoint(args.configPath, args.filePath)).toBeNull();
    await expect(publishIsolatedWebEndpoint(args)).rejects.toThrow("Unsafe");
    expect(
      await readIsolatedWebEndpoint(args.configPath, join(args.directory, "arbitrary.json")),
    ).toBeNull();
    await chmod(args.directory, 0o755);
    await expect(publishIsolatedWebEndpoint(args)).rejects.toThrow("Unsafe");
  });
  it("retains dead child's invalid receipt and old cleanup cannot delete ready successor", async () => {
    const args = await fixture();
    const source = await readFile(resolve("../scripts/spur-isolated-ui.sh"), "utf8");
    const start = source.indexOf("cleanup() {");
    const end = source.indexOf("\ntrap cleanup", start);
    const cleanup = source.slice(start, end);
    const marker = join(args.directory, "shared-unlink");
    const script = `set -euo pipefail\nNEXT_ENV_BACKUP="$1/backup-a"\nTSCONFIG_BACKUP="$1/backup-b"\nRECEIPT_FILE="$1/ui-endpoint.json"\nSHARED_UNLINK_MARKER="$1/shared-unlink"\nWEB_PID=""\nrestore_next_type_files() { echo CLEANUP_PAUSED; read -r; }\nrm() { for arg in "$@"; do if [[ "$arg" == "$RECEIPT_FILE" ]]; then echo unlink > "$SHARED_UNLINK_MARKER"; fi; done; command rm "$@"; }\n${cleanup}\necho OWNER_READY\nread -r\ncleanup\n`;
    const owner = spawn("bash", ["-c", script, "fixture", args.directory], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const waitFor = (text: string) =>
      new Promise<void>((done, reject) => {
        const check = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes(text)) {
            owner.stdout.off("data", check);
            done();
          }
        };
        owner.stdout.on("data", check);
        owner.on("error", reject);
      });
    try {
      await waitFor("OWNER_READY");
      if (owner.pid === undefined) throw new Error("Missing owner PID");
      await publishIsolatedWebEndpoint({ ...args, pid: owner.pid });
      const paused = waitFor("CLEANUP_PAUSED");
      owner.stdin.write("cleanup\n");
      await paused;
      await publishIsolatedWebEndpoint({ ...args, port: 5643 });
      const successor = await readFile(args.filePath, "utf8");
      const exited = once(owner, "exit");
      owner.stdin.end("resume\n");
      await exited;
      expect(await readFile(args.filePath, "utf8")).toBe(successor);
      expect(await readIsolatedWebEndpoint(args.configPath, args.filePath)).toBe(
        "http://127.0.0.1:5643",
      );
      await expect(lstat(marker)).rejects.toThrow();
      // A retained claim from the exited supervisor is invalid without unlink.
      const receipt = parseReceipt(successor);
      await writeFile(args.filePath, JSON.stringify({ ...receipt, pid: owner.pid }));
      expect(await readIsolatedWebEndpoint(args.configPath, args.filePath)).toBeNull();
      expect((await lstat(args.filePath)).isFile()).toBe(true);
    } finally {
      if (owner.exitCode === null) owner.kill();
    }
  });
  it("publishes from actual assigned-port readiness boundary and bin supervisor PID", async () => {
    const args = await fixture();
    const source = await readFile(resolve("../scripts/spur-isolated-ui.sh"), "utf8");
    const start = source.indexOf('wait_for_http "http://127.0.0.1:$UI_PORT"');
    const end = source.indexOf("\nfor _", start);
    const boundary = source.slice(start, end);
    const script = `set -euo pipefail\nSCRIPT_DIR="$1/scripts"\nSPUR_ISOLATED_CONFIG="$2"\nSPUR_ISOLATED_UI_ENDPOINT_FILE="$3"\nUI_PORT="$4"\nDAEMON_LIFECYCLE_ID="fixture"\nvalidate_daemon_generation() { :; }\nwait_for_http() { [[ ! -e "$SPUR_ISOLATED_UI_ENDPOINT_FILE" ]]; [[ "$1" == "http://127.0.0.1:$UI_PORT" ]]; }\n${boundary}\n`;
    execFileSync("bash", [
      "-c",
      script,
      "fixture",
      resolve(".."),
      args.configPath,
      args.filePath,
      String(args.port),
    ]);
    const receipt = parseReceipt(await readFile(args.filePath, "utf8"));
    expect(receipt.port).toBe(args.port);
    expect(receipt.pid).not.toBe(process.pid);
    expect(await readIsolatedWebEndpoint(args.configPath, args.filePath)).toBeNull();
    expect(boundary).not.toContain("spur-sidecar");
  });
});

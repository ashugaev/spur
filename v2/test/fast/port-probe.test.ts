import { createServer, type Server } from "node:net";
import type * as childProcessModule from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

type ExecFileAsync = (
  file: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

// child_process.execFile carries its own `util.promisify.custom`
// implementation; a bare `vi.fn()` mock does not, so `promisify(execFile)`
// falls back to the generic single-value callback adapter and silently
// drops stderr. Attaching `[promisify.custom]` to the mock (mirroring
// runtime-tmux.test.ts) makes the module-under-test's own
// `promisify(execFile)` resolve exactly the `{stdout, stderr}` shape
// production code sees.
const execFileAsyncMock = vi.fn<ExecFileAsync>();
const execFileMock: ((...args: unknown[]) => void) & {
  [promisify.custom]: typeof execFileAsyncMock;
} = Object.assign(vi.fn(), {
  [promisify.custom]: execFileAsyncMock,
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

const {
  findListenerPids,
  isHostPortFree,
  hasEstablishedConnections,
  snapshotListeners,
  _parseSsListenersForTests,
  _parseLsofListenersForTests,
} = await import("../../src/port-probe.js");

const openServers: Server[] = [];

describe("snapshotListeners", () => {
  it("preserves IPv4, IPv6, anonymous presence and multiple listener PIDs", () => {
    const snapshot = _parseSsListenersForTests(
      [
        'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=4))',
        'LISTEN 0 511 [::]:3000 [::]:* users:(("node",pid=13,fd=4))',
        "LISTEN 0 511 *:3001 *:*",
      ].join("\n"),
    );
    expect(snapshot).toEqual({
      ok: true,
      byPort: new Map([
        [3000, new Set([12, 13])],
        [3001, new Set()],
      ]),
      unattributedPorts: new Set([3001]),
    });
    expect(_parseSsListenersForTests("")).toEqual({ ok: true, byPort: new Map() });
    expect(_parseSsListenersForTests("malformed")).toEqual({ ok: false });
  });

  it("falls back once for unusable ss and parses lsof machine output", async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: "invalid", stderr: "" })
      .mockResolvedValueOnce({ stdout: "p12\nf4\nn[::1]:3000\np13\nf5\nn*:3000\n", stderr: "" });
    expect(await snapshotListeners()).toEqual({
      ok: true,
      byPort: new Map([[3000, new Set([12, 13])]]),
    });
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    expect(execFileAsyncMock.mock.calls.every((call) => call[2]?.timeout === 2000)).toBe(true);
    expect(_parseLsofListenersForTests("p12\nninvalid\n")).toEqual({ ok: false });
  });

  it("reports failed, timed-out or malformed observations as unknown", async () => {
    execFileAsyncMock.mockRejectedValue(new Error("timeout"));
    expect(await snapshotListeners()).toEqual({ ok: false });
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    execFileAsyncMock.mockResolvedValue({ stdout: "invalid", stderr: "" });
    expect(await snapshotListeners()).toEqual({ ok: false });
  });

  it("attributes a real TCP listener without an HTTP response", async () => {
    const actual = await vi.importActual<typeof childProcessModule>("node:child_process");
    const run = promisify(actual.execFile);
    execFileAsyncMock.mockImplementation(async (file, args, options) => {
      const result = await run(file, args, options);
      return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    });
    const server = createServer();
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    const snapshot = await snapshotListeners();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) expect(snapshot.byPort.get(address.port)?.has(process.pid)).toBe(true);
  });
});

afterEach(async () => {
  execFileAsyncMock.mockReset();
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("isHostPortFree", () => {
  it("returns true when no process is bound to the port", async () => {
    // Grab an ephemeral port, release it, then probe it.
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "0.0.0.0", () => {
        const addr = probe.address();
        if (typeof addr === "object" && addr) resolve(addr.port);
        else reject(new Error("no address"));
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    expect(await isHostPortFree(port)).toBe(true);
  });

  it("returns false when the host already has a listener on the port", async () => {
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "0.0.0.0", () => {
        const addr = probe.address();
        if (typeof addr === "object" && addr) resolve(addr.port);
        else reject(new Error("no address"));
      });
    });
    openServers.push(probe);
    expect(await isHostPortFree(port)).toBe(false);
  });
});

describe("findListenerPids", () => {
  it("bounds the lsof/ss listener lookup with a timeout so a hung tool can never hang doctor", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });

    await findListenerPids(4310);

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "lsof",
      expect.any(Array),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("returns [] (not a throw) when lsof finds nothing and ss is unavailable — lsof's own zero-row answer is a real result", async () => {
    execFileAsyncMock.mockImplementation(async (file: string) => {
      if (file === "lsof") return { stdout: "", stderr: "" };
      throw Object.assign(new Error("ss: command not found"), { code: "ENOENT" });
    });

    await expect(findListenerPids(4311)).resolves.toEqual([]);
  });

  // 859/N1: a probe failure (both tools missing, or both timing out) must
  // never collapse to the same "[]" a genuinely free port produces — a host
  // with neither tool would otherwise let a real listener go unreported.
  // Mutation check: reverting findListenerPids to swallow every failure to
  // "" (the pre-fix `execFileOutput` shape) makes this test fail — the
  // Promise resolves to [] instead of rejecting.
  it("859/N1: throws when NEITHER lsof nor ss produces a usable result — a probe failure is never proof the port is free", async () => {
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error("command not found"), { code: "ENOENT" }),
    );

    await expect(findListenerPids(4312)).rejects.toThrow(/probe unavailable/);
  });

  it("859/N1: throws when both tools time out, not just when they are missing", async () => {
    execFileAsyncMock.mockRejectedValue(Object.assign(new Error("timed out"), { killed: true }));

    await expect(findListenerPids(4313)).rejects.toThrow(/probe unavailable/);
  });
});

describe("hasEstablishedConnections", () => {
  it("returns established when ss prints a connection row beyond the header", async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout:
        "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port\n" +
        "ESTAB  0      0      127.0.0.1:3002       127.0.0.1:54321\n",
      stderr: "",
    });

    expect(await hasEstablishedConnections(3002)).toBe("established");
  });

  it("returns none when ss prints only the header", async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port\n",
      stderr: "",
    });

    expect(await hasEstablishedConnections(3003)).toBe("none");
  });

  it("returns unknown, not none, when ss is missing (ENOENT)", async () => {
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error("spawn ss ENOENT"), { code: "ENOENT" }),
    );

    expect(await hasEstablishedConnections(3004)).toBe("unknown");
  });

  it("returns unknown on a non-zero exit", async () => {
    execFileAsyncMock.mockRejectedValue(Object.assign(new Error("ss failed"), { code: 1 }));

    expect(await hasEstablishedConnections(3005)).toBe("unknown");
  });

  it("returns unknown for an invalid port without shelling out", async () => {
    expect(await hasEstablishedConnections(-1)).toBe("unknown");
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });
});

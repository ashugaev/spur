import { createServer, type Server } from "node:net";
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

const { findListenerPids, isHostPortFree, hasEstablishedConnections } =
  await import("../../src/port-probe.js");

const openServers: Server[] = [];

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

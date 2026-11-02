import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runScriptProcess,
  type ScriptProcessResult,
} from "../../src/event-sources/script-process.js";
import { scriptSourceModule } from "../../src/event-sources/script.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(body: string) {
  const cwd = await mkdtemp(join(tmpdir(), "spur-script-process-"));
  dirs.push(cwd);
  await writeFile(join(cwd, "check.sh"), `#!/bin/sh\n${body}\n`);
  await chmod(join(cwd, "check.sh"), 0o700);
  const controller = new AbortController();
  return {
    cwd,
    controller,
    request: {
      command: ["./check.sh"],
      cwd,
      env: { SPUR_STATE_DIR: cwd, FIXTURE: "yes" },
      timeoutMs: 800,
      signal: controller.signal,
    },
  };
}

async function assertDead(pid: number) {
  await vi.waitFor(
    async () => {
      // A killed orphan can be a zombie until host init reaps it; it cannot execute.
      try {
        const status = await readFile(`/proc/${pid}/stat`, "utf8");
        expect(status.split(") ")[1]?.startsWith("Z")).toBe(true);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    },
    { timeout: 1000 },
  );
}

describe("script process", () => {
  it.each(["timeout", "abort", "output_limit"] as const)(
    "settles %s while escaped descendants hold inherited pipes",
    async (action) => {
      const { cwd, request, controller } = await fixture(
        'setsid sh -c \'printf "%s" "$$" > escaped.pid; exec sleep 30\' &\nprintf "%s" "$$" > leader.pid\n' +
          (action === "output_limit"
            ? "while [ ! -s escaped.pid ]; do sleep 0.01; done\nhead -c 2097152 /dev/zero\n"
            : "") +
          "wait",
      );
      let result: ScriptProcessResult | undefined;
      const pending = runScriptProcess({
        ...request,
        timeoutMs: action === "timeout" ? 300 : 2000,
      }).then((value) => {
        result = value;
        return value;
      });
      let escapedPid: number | undefined;
      try {
        await vi.waitFor(async () => {
          const pid = await readFile(join(cwd, "escaped.pid"), "utf8");
          expect(pid).toMatch(/^[1-9]\d*$/);
          escapedPid = Number(pid);
        });
        if (action === "abort") controller.abort();
        await vi.waitFor(
          () =>
            expect(result).toMatchObject(
              action === "abort" ? { status: "aborted" } : { status: "failed", reason: action },
            ),
          { timeout: 1000 },
        );
        await assertDead(Number(await readFile(join(cwd, "leader.pid"), "utf8")));
      } finally {
        if (escapedPid !== undefined) process.kill(escapedPid, "SIGKILL");
        await pending;
      }
    },
  );

  it("stops script source without waiting for escaped descendants to close pipes", async () => {
    const { cwd, request } = await fixture(
      'setsid sh -c \'printf "%s" "$$" > escaped.pid; exec sleep 30\' &\nwait',
    );
    const emit = vi.fn();
    const handle = await scriptSourceModule.start({
      sourceId: "check",
      projectId: "api",
      dataDir: cwd,
      config: {
        type: "script",
        command: request.command,
        cwd,
        env: {},
        schedule: "* * * * *",
        timeoutMs: 2000,
        emitExisting: true,
        runOnStart: true,
      },
      emit,
      signal: request.signal,
      logger: {},
      resolveWebBaseUrl: async () => null,
    });
    let escapedPid: number | undefined;
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      handle.runOnStart?.();
      await vi.waitFor(async () => {
        const pid = await readFile(join(cwd, "escaped.pid"), "utf8");
        expect(pid).toMatch(/^[1-9]\d*$/);
        escapedPid = Number(pid);
      });
      stopping = Promise.resolve(handle.stop()).then(() => {
        stopped = true;
      });
      await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 1000 });
      expect(emit).not.toHaveBeenCalled();
    } finally {
      if (escapedPid !== undefined) process.kill(escapedPid, "SIGKILL");
      await (stopping ?? handle.stop());
    }
  });

  it("runs relative argv executable with exact stdout and closed stdin", async () => {
    const { request } = await fixture('read x || printf "[]"');
    expect(await runScriptProcess(request)).toMatchObject({ status: "ok", stdout: "[]" });
  });
  it("reports exit code, signal and missing executable without throwing", async () => {
    const { request } = await fixture('printf "failure" >&2; exit 3');
    expect(await runScriptProcess(request)).toMatchObject({
      status: "failed",
      reason: "exit",
      exitCode: 3,
      stderrTail: "failure",
    });
    expect(await runScriptProcess({ ...request, command: ["./missing"] })).toMatchObject({
      status: "failed",
      reason: "spawn",
    });
    expect(
      await runScriptProcess({ ...request, command: ["/bin/sh", "-c", "kill -TERM $$"] }),
    ).toMatchObject({ status: "failed", reason: "signal", signal: "SIGTERM" });
  });
  it("kills background descendants on timeout and abort", async () => {
    const { cwd, request, controller } = await fixture(
      'sleep 30 &\nprintf "%s" "$!" > child.pid\nwait',
    );
    expect(await runScriptProcess({ ...request, timeoutMs: 150 })).toMatchObject({
      status: "failed",
      reason: "timeout",
    });
    await assertDead(Number(await readFile(join(cwd, "child.pid"), "utf8")));
    await rm(join(cwd, "child.pid"));
    const pending = runScriptProcess(request);
    await vi.waitFor(async () =>
      expect(await readFile(join(cwd, "child.pid"), "utf8")).toMatch(/^\d+$/),
    );
    const pid = Number(await readFile(join(cwd, "child.pid"), "utf8"));
    controller.abort();
    expect(await pending).toEqual({ status: "aborted" });
    await assertDead(pid);
  });
  it("kills background leftovers when leader exits successfully", async () => {
    const { cwd, request } = await fixture('sleep 30 &\nprintf "%s" "$!" > child.pid\nprintf "[]"');
    expect(await runScriptProcess(request)).toMatchObject({ status: "ok", stdout: "[]" });
    await assertDead(Number(await readFile(join(cwd, "child.pid"), "utf8")));
  });
  it("limits stdout and retains only stderr tail", async () => {
    const { request } = await fixture("head -c 2097152 /dev/zero");
    expect(await runScriptProcess(request)).toMatchObject({
      status: "failed",
      reason: "output_limit",
    });
    const result = await runScriptProcess({
      ...request,
      command: ["/bin/sh", "-c", 'head -c 10000 /dev/zero >&2; printf "end" >&2'],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(Buffer.byteLength(result.stderrTail)).toBe(2048);
      expect(result.stderrTail.endsWith("end")).toBe(true);
    }
  });
  it("copies allowlisted env and configured keys without daemon secrets", async () => {
    vi.stubEnv("SPUR_TEST_LEAK", "secret");
    vi.stubEnv("GITHUB_TOKEN", "secret");
    const { request } = await fixture("env");
    const result = await runScriptProcess(request);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.stdout).not.toMatch(/SPUR_TEST_LEAK|GITHUB_TOKEN/);
      expect(result.stdout).toContain("PATH=");
      expect(result.stdout).toContain(`SPUR_STATE_DIR=${request.cwd}`);
      expect(result.stdout).toContain("FIXTURE=yes");
    }
  });
});

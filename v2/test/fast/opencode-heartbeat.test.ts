import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenCodeConfig,
  ensureOpenCodeHeartbeatPlugin,
  openCodeHeartbeatExpired,
} from "../../src/agents/opencode.js";

describe("OpenCode worker heartbeat", () => {
  let directory: string;
  const now = Date.parse("2026-10-13T06:00:00Z");

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "spur-opencode-heartbeat-"));
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it("expires an established current launch after 60 seconds and recovers on a fresh beat", async () => {
    const path = join(directory, "opencode-heartbeat.json");
    await writeFile(path, JSON.stringify({ agentLaunchId: "launch", updatedAt: now - 60_000 }));
    expect(await openCodeHeartbeatExpired(directory, "launch", now)).toBe(false);
    expect(await openCodeHeartbeatExpired(directory, "launch", now + 1)).toBe(true);
    await writeFile(path, JSON.stringify({ agentLaunchId: "launch", updatedAt: now }));
    expect(await openCodeHeartbeatExpired(directory, "launch", now + 1)).toBe(false);
    expect(await openCodeHeartbeatExpired(directory, "restored-launch", now + 120_000)).toBe(false);
    expect(await openCodeHeartbeatExpired(directory, undefined, now + 120_000)).toBe(false);
  });

  it.each([
    "not json",
    "null",
    JSON.stringify({ agentLaunchId: "old-launch", updatedAt: now - 120_000 }),
    JSON.stringify({ agentLaunchId: "launch", updatedAt: "invalid" }),
    JSON.stringify({ agentLaunchId: "launch", updatedAt: 0 }),
    JSON.stringify({ agentLaunchId: "launch", updatedAt: now + 120_000 }),
  ])("ignores unknown or foreign heartbeat evidence: %s", async (body) => {
    await writeFile(join(directory, "opencode-heartbeat.json"), body);
    expect(await openCodeHeartbeatExpired(directory, "launch", now)).toBe(false);
  });

  it("leaves startup and older sessions without a heartbeat unchanged", async () => {
    expect(await openCodeHeartbeatExpired(directory, "launch", now)).toBe(false);
  });

  it("resumes an established heartbeat after transient storage failure", async () => {
    const pluginPath = await ensureOpenCodeHeartbeatPlugin(directory);
    vi.stubEnv("SPUR_AGENT_LAUNCH_ID", "launch");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const plugin = (await import(pathToFileURL(pluginPath).href)) as {
      SpurHeartbeat(): Promise<object>;
    };
    await plugin.SpurHeartbeat();
    const path = join(directory, "opencode-heartbeat.json");
    const established = await readFile(path, "utf8");
    const temporary = join(directory, `opencode-heartbeat.json.${process.pid}.tmp`);
    await mkdir(temporary);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await readFile(path, "utf8")).toBe(established);
    expect(log).toHaveBeenCalledTimes(1);
    await rm(temporary, { recursive: true });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      agentLaunchId: "launch",
      updatedAt: now + 65_000,
    });
    expect(await openCodeHeartbeatExpired(directory, "launch")).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("installs a native plugin that keeps beating during asynchronous work", async () => {
    const pluginPath = await ensureOpenCodeHeartbeatPlugin(directory);
    const config = JSON.parse(buildOpenCodeConfig(undefined, false, undefined, pluginPath) ?? "{}");
    expect(config.plugin).toEqual([pathToFileURL(pluginPath).href]);
    vi.stubEnv("SPUR_AGENT_LAUNCH_ID", "launch");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const plugin = (await import(pathToFileURL(pluginPath).href)) as {
      SpurHeartbeat(): Promise<object>;
    };
    await plugin.SpurHeartbeat();
    const asynchronousWork = new Promise<void>((resolve) => setTimeout(resolve, 120_000));
    await vi.advanceTimersByTimeAsync(120_000);
    await asynchronousWork;
    const heartbeat = JSON.parse(
      await readFile(join(directory, "opencode-heartbeat.json"), "utf8"),
    );
    expect(heartbeat).toEqual({ agentLaunchId: "launch", updatedAt: now + 120_000 });
    expect(await openCodeHeartbeatExpired(directory, "launch")).toBe(false);
  });
});

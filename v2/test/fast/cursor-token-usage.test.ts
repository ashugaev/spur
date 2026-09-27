import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCursorTokenUsageHook, readCursorTokenUsage } from "../../src/cursor-token-usage.js";

const dirs: string[] = [];
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cursor-usage-test-"));
  dirs.push(dir);
  await ensureCursorTokenUsageHook(dir, join(dir, "config"));
  return dir;
}
async function report(
  dir: string,
  generation: string,
  usage: Record<string, unknown> = {},
  configDir = join(dir, "config"),
) {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [join(dir, ".cursor", "spur-cursor-token-usage.mjs")],
      { env: { ...process.env, CURSOR_CONFIG_DIR: configDir } },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin?.end(
      JSON.stringify({
        conversation_id: "chat",
        generation_id: generation,
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 70,
        cache_write_tokens: 10,
        ...usage,
      }),
    );
  });
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Cursor structured stop usage", () => {
  it("routes concurrent shared-workspace sessions to their own config directories", async () => {
    const dir = await setup();
    const second = join(dir, "second-config");
    await Promise.all([
      ensureCursorTokenUsageHook(dir, join(dir, "config")),
      ensureCursorTokenUsageHook(dir, second),
    ]);
    await Promise.all([report(dir, "first"), report(dir, "second", { output_tokens: 40 }, second)]);
    expect((await readCursorTokenUsage(join(dir, "config"), "chat"))?.totalTokens).toBe(120);
    expect((await readCursorTokenUsage(second, "chat"))?.totalTokens).toBe(140);
    const hooks = JSON.parse(await readFile(join(dir, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.stop).toHaveLength(1);
  });
  it("does not fail the provider when the usage destination cannot be written", async () => {
    const dir = await setup();
    const blocked = join(dir, "blocked-config");
    await writeFile(blocked, "not a directory");
    await expect(report(dir, "first", {}, blocked)).resolves.toBeUndefined();
    expect(await readCursorTokenUsage(blocked, "chat")).toBeUndefined();
  });
  it("reads counters captured from a live interactive Cursor stop hook", async () => {
    const dir = await setup();
    const usage: unknown = JSON.parse(
      await readFile(new URL("./fixtures/cursor-token-usage-stop.json", import.meta.url), "utf8"),
    );
    await report(dir, "live", usage as Record<string, unknown>);
    expect(await readCursorTokenUsage(join(dir, "config"), "chat")).toEqual({
      inputTokens: 13677,
      outputTokens: 55,
      totalTokens: 13732,
      cacheReadInputTokens: 4736,
      cacheWriteInputTokens: 0,
    });
  });
  it("counts gross input once, sums generations, and deduplicates repeated delivery", async () => {
    const dir = await setup();
    await report(dir, "first");
    await report(dir, "first");
    await report(dir, "second");
    expect(await readCursorTokenUsage(join(dir, "config"), "chat")).toEqual({
      inputTokens: 200,
      outputTokens: 40,
      totalTokens: 240,
      cacheReadInputTokens: 140,
      cacheWriteInputTokens: 20,
    });
    expect(await readCursorTokenUsage(join(dir, "config"), "other")).toBeUndefined();
    expect(await readCursorTokenUsage(join(dir, "config"), undefined)).toBeUndefined();
  });
  it("distinguishes missing counters from measured zero", async () => {
    const dir = await setup();
    expect(await readCursorTokenUsage(join(dir, "config"), "chat")).toBeUndefined();
    await report(dir, "zero", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    expect((await readCursorTokenUsage(join(dir, "config"), "chat"))?.totalTokens).toBe(0);
  });
  it("rejects corrupt or impossible cache counters", async () => {
    const dir = await setup();
    await report(dir, "bad", { cache_read_tokens: 101 });
    expect(await readCursorTokenUsage(join(dir, "config"), "chat")).toBeUndefined();
    const usageDir = join(dir, "config", "token-usage", Buffer.from("chat").toString("hex"));
    const [file] = await readdir(usageDir);
    if (!file) throw new Error("Missing usage fixture");
    await writeFile(join(usageDir, file), "not json");
    expect(await readCursorTokenUsage(join(dir, "config"), "chat")).toBeUndefined();
  });
  it("preserves existing hooks and installs one collector", async () => {
    const dir = await setup();
    const path = join(dir, ".cursor", "hooks.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        hooks: { stop: [{ command: "custom" }], beforeShellExecution: [{ command: "guard" }] },
      }),
    );
    await ensureCursorTokenUsageHook(dir, join(dir, "config"));
    await ensureCursorTokenUsageHook(dir, join(dir, "config"));
    const config = JSON.parse(await readFile(path, "utf8"));
    expect(config.hooks.stop).toHaveLength(2);
    expect(config.hooks.stop[0]).toEqual({ command: "custom" });
    expect(config.hooks.beforeShellExecution).toEqual([{ command: "guard" }]);
  });
});

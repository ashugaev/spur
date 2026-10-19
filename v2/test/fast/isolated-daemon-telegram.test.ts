import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { loadProjectConfig } from "../../src/config.js";
import { buildIsolatedProjectConfig } from "../../src/isolated-project-config.js";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("keeps voice-capable UI entrypoint composed by the existing dependency", () => {
  const path = mkdtempSync(join(tmpdir(), "spur-test-sidecar-composition-"));
  paths.push(path);
  execFileSync("git", ["init", "-q"], { cwd: path });
  const source = readFileSync(resolve("../spur.yaml"), "utf8");
  const configPath = join(path, "spur.yaml");
  // Remove parent sources through the same adapter; no production env needed.
  writeFileSync(configPath, buildIsolatedProjectConfig(source, path));
  const project = loadProjectConfig(configPath).projects["sp"];
  if (!project) throw new Error("Missing project");
  expect(project.sidecars["isolated-ui"]?.dependsOn).toEqual(["isolated-daemon"]);
  expect(project.sidecars["isolated-ui"]?.autoStart).toBe(false);
  expect(project.sidecars["isolated-daemon"]?.autoStart).toBe(false);
});

it("holds the launcher bot lock through exec, disables a contender, releases on exit", async () => {
  const path = mkdtempSync(join(tmpdir(), "spur-test-telegram-lock-"));
  paths.push(path);
  const source = readFileSync(resolve("../scripts/spur-isolated-daemon.sh"), "utf8");
  const start = source.indexOf("# Hold the bot lock");
  const end = source.indexOf("\n# Advertise only final configs", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const boundary = source.slice(start, end);
  const lock = join(path, "bot.lock");
  const writer = join(path, "writer.cjs");
  writeFileSync(
    writer,
    `const fs=require('node:fs');const args=process.argv.slice(2);const i=args.indexOf('--telegram-lock-output');if(i!==-1)fs.writeFileSync(args[i+1],${JSON.stringify(lock)});else if(args.includes('--without-telegram'))console.log('SOURCE_FREE');`,
  );
  const script = `set -euo pipefail\nNODE_BIN="$1"\nWRITE_CONFIG_PATH="$2"\nCONFIG_DIR="$3"\nWRITE_CONFIG_ARGS=()\n${boundary}\nexec "$NODE_BIN" -e 'console.log("STARTED");process.stdin.resume()'\n`;
  const config = join(path, "config");
  execFileSync("mkdir", [config]);
  const owner = spawn("bash", ["-c", script, "fixture", process.execPath, writer, config], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const started = new Promise<void>((resolveStarted, reject) => {
    owner.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("STARTED")) resolveStarted();
    });
    owner.on("error", reject);
  });
  try {
    await started;
    const contender = execFileSync(
      "bash",
      ["-c", `${script}\n`, "fixture", process.execPath, writer, config],
      { input: "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(contender).toContain("SOURCE_FREE");
    owner.stdin.end();
    await once(owner, "exit");
    const restarted = execFileSync(
      "bash",
      ["-c", script, "fixture", process.execPath, writer, config],
      { input: "", encoding: "utf8" },
    );
    expect(restarted).toContain("STARTED");
    expect(restarted).not.toContain("SOURCE_FREE");
  } finally {
    if (owner.exitCode === null) owner.kill();
  }
});

import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess, type ExecFileOptions } from "node:child_process";
import type * as childProcessModule from "node:child_process";
import type * as fsPromisesModule from "node:fs/promises";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import * as reap from "../../src/sidecars/reap.js";
import { loadProjectConfig, projectConfigSource } from "../../src/config.js";
import {
  callerSourceMatches,
  captureConfiguredCaller,
  parseCallerSourceSnapshot,
  readConfiguredCaller,
  type CallerPin,
  type CallerSourceSnapshot,
} from "../../src/release-caller.js";
import { createTempDir } from "../helpers/common.js";

const roots: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromisesModule>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function pin(file: string): Promise<CallerPin> {
  return {
    file: await realpath(file),
    digest: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  };
}
async function fixture() {
  const root = await createTempDir("spur-caller-");
  roots.push(root);
  const file = join(root, "source.yaml");
  await writeFile(
    file,
    `projects:\n  reviewers:\n    path: ${root}\n    sources:\n      gh:\n        type: github\n        query: repo:owner/repo\n    triggers:\n      review:\n        source: gh\n        event: github:work_item.new\n        spawn:\n          blocks:\n            - agent: codex\n              prompt: code\n            - agent: codex\n              prompt: browser\n`,
  );
  const config = loadProjectConfig(file);
  const project = config.projects["reviewers"];
  if (!project) throw new Error("missing project");
  const trigger = project.triggers["review"];
  if (!trigger) throw new Error("missing trigger");
  const snapshot: CallerSourceSnapshot = {
    kind: "configured-source",
    generation: 1,
    projectId: "reviewers",
    sourceId: "gh",
    triggerId: "review",
    config: await pin(file),
    effectiveDigest: createHash("sha256")
      .update(JSON.stringify({ source: project.sources["gh"], trigger }))
      .digest("hex"),
    blocks: { code: 0, browser: 1 },
    runtime: await pin(process.execPath),
    modules: [await pin(fileURLToPath(new URL("release-caller-fixture.mjs", import.meta.url)))],
  };
  return { root, config, project, snapshot };
}
test("factual source capture precedes designation, preserves raw origin and rejects copied config/drift", async () => {
  const f = await fixture();
  const request = {
    projectId: "reviewers",
    sourceId: "gh",
    triggerId: "review",
    blockIndex: 0,
    repository: "owner/repo",
    pr: 4,
    prompt: "code",
  };
  const fact = await captureConfiguredCaller(f.config, request);
  expect(fact).toMatchObject({ config: f.snapshot.config, blockIndex: 0, pr: 4 });
  expect(fact).not.toHaveProperty("generation");
  expect(fact).not.toHaveProperty("lane");
  expect(callerSourceMatches(f.config, f.snapshot)).toBe(true);
  const copied = { ...f.project };
  f.config.projects["reviewers"] = copied;
  expect(projectConfigSource(copied)).toBeNull();
  expect(await captureConfiguredCaller(f.config, request)).toBeNull();
  expect(callerSourceMatches(f.config, f.snapshot)).toBe(false);
  f.config.projects["reviewers"] = f.project;
  await writeFile(f.snapshot.config.file, "projects: {}\n");
  expect(await captureConfiguredCaller(f.config, request)).toBeNull();
});
test("owned child readback ignores copied process claims and rejects pin/status drift", async () => {
  const f = await fixture();
  const tool = f.snapshot.modules[0];
  if (!tool) throw new Error("missing tool");
  const appsFile = join(f.root, "apps.json");
  await writeFile(appsFile, JSON.stringify({ status: "OK" }));
  const apps = await pin(appsFile);
  const verify = async (expected: CallerPin) => {
    expect(await pin(expected.file)).toEqual(expected);
  };
  Object.assign(f.snapshot, { pid: process.pid, stdout: "forged readback", executable: "copied" });
  const result = await readConfiguredCaller(f.snapshot, tool, apps, "owner/repo", verify);
  expect(result.version).toBe("fixture-current");
  expect(result.processes).toHaveLength(2);
  expect(result.processes.every((row) => row.pid !== process.pid && row.identity.length > 0)).toBe(
    true,
  );
  await writeFile(appsFile, JSON.stringify({ status: "BLOCKED" }));
  await expect(
    readConfiguredCaller(f.snapshot, tool, apps, "owner/repo", verify),
  ).rejects.toThrow();
  const changedApps = await pin(appsFile);
  await expect(
    readConfiguredCaller(f.snapshot, tool, changedApps, "owner/repo", verify),
  ).rejects.toThrow("caller-status-invalid");
});
test.each(["ENOENT", "EACCES"])("optional source read %s supplies no caller fact", async (code) => {
  const f = await fixture();
  vi.mocked(readFile).mockRejectedValueOnce(
    Object.assign(new Error("source unavailable"), { code }),
  );
  expect(
    await captureConfiguredCaller(f.config, {
      projectId: "reviewers",
      sourceId: "gh",
      triggerId: "review",
      blockIndex: 0,
      repository: "owner/repo",
      pr: 4,
      prompt: "code",
    }),
  ).toBeNull();
});
test("source snapshot rejects same-index lanes and missing runtime closure", () => {
  expect(() => parseCallerSourceSnapshot({ kind: "configured-source", modules: [] })).toThrow();
});

test("owned readback rejects timeout and unavailable PID identity", async () => {
  const f = await fixture();
  const tool = f.snapshot.modules[0];
  if (!tool) throw new Error("missing tool");
  const appsFile = join(f.root, "apps.json");
  await writeFile(appsFile, JSON.stringify({ status: "OK" }));
  const apps = await pin(appsFile);
  const verify = async (expected: CallerPin) => expect(await pin(expected.file)).toEqual(expected);
  const actual = await vi.importActual<typeof childProcessModule>("node:child_process");
  const invoke = execFile as unknown as (
    file: string,
    args: string[],
    options: ExecFileOptions,
    callback: (error: Error | null, stdout: string) => void,
  ) => ChildProcess;
  vi.mocked(invoke).mockImplementationOnce((file, args, options, callback) =>
    actual.execFile(file, args, { ...options, timeout: 10, encoding: "utf8" }, callback),
  );
  await expect(
    readConfiguredCaller(f.snapshot, tool, apps, "owner/repo", verify),
  ).rejects.toThrow();
  const actualProbe = reap.readProcStarttime;
  for (const kind of ["gone", "unknown"] as const) {
    vi.spyOn(reap, "readProcStarttime").mockResolvedValueOnce({ kind });
    await expect(
      readConfiguredCaller(f.snapshot, tool, apps, "owner/repo", verify),
    ).rejects.toThrow("caller-process-unavailable");
  }
  vi.spyOn(reap, "readProcStarttime").mockImplementationOnce(async (pid) => {
    const identity = await actualProbe(pid);
    const readText = readFile as (path: string, encoding: "utf8") => Promise<string>;
    vi.mocked(readText).mockResolvedValueOnce("untrusted\0process\0");
    return identity;
  });
  await expect(readConfiguredCaller(f.snapshot, tool, apps, "owner/repo", verify)).rejects.toThrow(
    "caller-process-mismatch",
  );
});

test("concurrent untrusted process cannot substitute owned readback", async () => {
  const f = await fixture();
  const tool = f.snapshot.modules[0];
  if (!tool) throw new Error("missing tool");
  const appsFile = join(f.root, "apps.json");
  await writeFile(appsFile, JSON.stringify({ status: "OK" }));
  const apps = await pin(appsFile);
  const other = spawn(process.execPath, [
    "-e",
    "process.stdout.write('forged-current');setTimeout(()=>{},10000)",
  ]);
  const closed = new Promise<void>((resolve) => other.once("close", () => resolve()));
  try {
    Object.assign(f.snapshot, { pid: other.pid, identity: "copied", stdout: "forged-current" });
    const result = await readConfiguredCaller(
      f.snapshot,
      tool,
      apps,
      "owner/repo",
      async (pinValue) => {
        expect(await pin(pinValue.file)).toEqual(pinValue);
      },
    );
    expect(result.version).toBe("fixture-current");
    expect(result.processes.every((row) => row.pid !== other.pid)).toBe(true);
    expect(other.exitCode).toBeNull();
  } finally {
    other.kill();
    await closed;
  }
});

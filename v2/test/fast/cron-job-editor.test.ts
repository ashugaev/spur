import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadInstanceConfigReadOnly, parseConfigText } from "../../src/config.js";
import {
  CronJobEditError,
  cronJobIdentity,
  readCronJobDraft,
  saveCronJobDraft,
  type CronJobEditorContext,
} from "../../src/cron-job-editor.js";
import { cleanupTrackedTempDirs, createTempDir } from "../helpers/common.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const ID = { projectId: "demo", sourceId: "nightly", triggerId: "audit" };
const SPAWN =
  "        spawn:\n          prompt: '  Audit sessions  '\n          agent: claude\n          model: 'custom-model'\n          reasoningEffort: high";

afterEach(() => {
  vi.clearAllMocks();
  return cleanupTrackedTempDirs();
});

async function fixture(spawn = SPAWN) {
  const root = await createTempDir("spur-cron-editor-");
  await mkdir(join(root, "repo"));
  const path = join(root, "spur.yaml");
  const text = [
    "# operator comment",
    "server: {port: 43987}",
    `dataDir: ${join(root, "data")}`,
    "custom: &unrelated {value: '${KEEP_RAW}'}",
    "customCopy: *unrelated",
    "sharedPrompt: &sharedPrompt aliased",
    "projects:",
    "  demo:",
    "    path: ./repo",
    "    sources:",
    "      nightly:",
    "        type: cron",
    "        schedule: '0 3 * * *' # daily schedule",
    "        runOnStart: false",
    "    triggers:",
    "      audit:",
    "        source: nightly",
    "        event: cron:tick",
    spawn,
    "      sibling:",
    "        source: nightly",
    "        event: cron:tick",
    "        spawn: {prompt: keep sibling}",
    "",
  ].join("\n");
  await writeFile(path, text);
  const loaded = loadInstanceConfigReadOnly(path);
  if (loaded.status !== "ok") throw new Error(`fixture: ${JSON.stringify(loaded)}`);
  const context: CronJobEditorContext = {
    bootstrapConfigPath: path,
    registryPaths: [],
    running: loaded.config,
  };
  return { root, path, text, context };
}

function update(draft: ReturnType<typeof readCronJobDraft>) {
  return {
    revision: draft.revision,
    schedule: draft.schedule,
    blocks: draft.blocks.map((block) => ({ ...block })),
  };
}

function expectCode(run: () => unknown, status: number, code: string) {
  expect(run).toThrowError(expect.objectContaining({ status, code }));
}

describe("CronJob YAML editor", () => {
  it("reads raw disk values with a matching whole-file revision during runtime drift", async () => {
    const f = await fixture();
    const disk = f.text.replace("Audit sessions", "Draft sessions");
    await writeFile(f.path, disk);
    const draft = readCronJobDraft(f.context, ID);
    expect(draft).toMatchObject({
      ownerPath: f.path,
      sourceTriggerIds: ["audit", "sibling"],
      blocks: [{ prompt: "  Draft sessions  " }],
    });
    expect(draft.revision).toBe(createHash("sha256").update(disk).digest("hex"));
    expect(f.context.running.projects["demo"]!.triggers!["audit"]).toMatchObject({
      spawn: { blocks: [{ prompt: "Audit sessions" }] },
    });
    expect(JSON.stringify(draft)).not.toContain("KEEP_RAW");
  });

  it("saves selected values, retains comments/raw unknown fields and leaves runtime unchanged", async () => {
    const f = await fixture();
    const draft = readCronJobDraft(f.context, ID);
    const body = update(draft);
    body.schedule = "*/10 * * * * *";
    body.blocks[0]!.prompt = "  Changed prompt\nwith a second line\n";
    body.blocks[0]!.model = "other-custom";
    const result = saveCronJobDraft(f.context, ID, body);
    expect(result).toMatchObject({
      saved: true,
      activation: "pending",
      schedule: body.schedule,
      blocks: body.blocks,
    });
    const text = await readFile(f.path, "utf8");
    expect(text).toContain("# operator comment");
    expect(text).toContain("# daily schedule");
    expect(text).toContain("${KEEP_RAW}");
    expect(text).toContain("&unrelated");
    expect(text).toContain("*unrelated");
    expect(text).toContain("keep sibling");
    expect(text.indexOf("schedule:")).toBeLessThan(text.indexOf("runOnStart:"));
    expect(readCronJobDraft(f.context, ID).blocks[0]!.prompt).toBe(body.blocks[0]!.prompt);
    expect(f.context.running.projects["demo"]!.sources!["nightly"]).toMatchObject({
      schedule: "0 3 * * *",
      runOnStart: false,
    });
  });

  it.each([
    ["mapping", "        spawn:\n          prompt: first\n          branch: feature/keep"],
    [
      "sequence",
      "        spawn:\n          - prompt: first\n            mode: keep\n          - prompt: second",
    ],
    [
      "blocks",
      "        spawn:\n          restrictWrites: true\n          blocks:\n            - prompt: first\n              steps: [keep-step]\n            - prompt: second",
    ],
  ])("retains %s spawn shape and absent optional overrides", async (_shape, spawn) => {
    const f = await fixture(spawn);
    const draft = readCronJobDraft(f.context, ID);
    expect(
      draft.blocks.every(
        (block) => block.agent === null && block.model === null && block.reasoningEffort === null,
      ),
    ).toBe(true);
    const body = update(draft);
    body.blocks[0]!.prompt = "changed first";
    saveCronJobDraft(f.context, ID, body);
    const before = parseYaml(f.text) as {
      projects: { demo: { triggers: { audit: { spawn: unknown } } } };
    };
    const after = parseYaml(await readFile(f.path, "utf8")) as typeof before;
    const beforeSpawn = before.projects.demo.triggers.audit.spawn;
    const afterSpawn = after.projects.demo.triggers.audit.spawn;
    expect(Array.isArray(afterSpawn)).toBe(Array.isArray(beforeSpawn));
    expect(JSON.stringify(afterSpawn)).not.toContain('"agent"');
    expect(readCronJobDraft(f.context, ID).blocks.slice(1)).toEqual(draft.blocks.slice(1));
    if (_shape === "mapping") expect(afterSpawn).toMatchObject({ branch: "feature/keep" });
    if (_shape === "blocks")
      expect(afterSpawn).toMatchObject({
        restrictWrites: true,
        blocks: [{ steps: ["keep-step"] }, {}],
      });
  });

  it("removes cleared override keys and skips every no-op byte rewrite", async () => {
    const f = await fixture();
    const draft = readCronJobDraft(f.context, ID);
    fs.chmodSync(f.path, 0o640);
    const before = fs.statSync(f.path);
    const result = saveCronJobDraft(f.context, ID, update(draft));
    expect(result.revision).toBe(draft.revision);
    expect(await readFile(f.path, "utf8")).toBe(f.text);
    expect(fs.statSync(f.path).mtimeMs).toBe(before.mtimeMs);
    const body = update(draft);
    body.blocks[0] = { ...body.blocks[0]!, agent: null, model: null, reasoningEffort: null };
    saveCronJobDraft(f.context, ID, body);
    const reopened = readCronJobDraft(f.context, ID);
    expect(reopened.blocks[0]).toMatchObject({ agent: null, model: null, reasoningEffort: null });
    expect(fs.statSync(f.path).mode & 0o777).toBe(0o640);
  });

  it("keeps untouched prompt/model whitespace when changing the schedule", async () => {
    const f = await fixture(SPAWN.replace("custom-model", "  custom-model  "));
    const draft = readCronJobDraft(f.context, ID);
    const body = update(draft);
    body.schedule = "0 4 * * *";
    saveCronJobDraft(f.context, ID, body);
    expect(readCronJobDraft(f.context, ID).blocks).toEqual(draft.blocks);
    expect(draft.blocks[0]).toMatchObject({
      prompt: "  Audit sessions  ",
      model: "  custom-model  ",
    });
  });

  it("rejects same-size stale writes and a second competing UI save", async () => {
    const f = await fixture();
    const draft = readCronJobDraft(f.context, ID);
    await writeFile(f.path, f.text.replace("Audit sessions", "Other sessions"));
    expectCode(() => saveCronJobDraft(f.context, ID, update(draft)), 409, "config_changed");
    expect(await readFile(f.path, "utf8")).toContain("Other sessions");
    const next = readCronJobDraft(f.context, ID);
    const body = update(next);
    body.blocks[0]!.prompt = "first save";
    saveCronJobDraft(f.context, ID, body);
    expectCode(() => saveCronJobDraft(f.context, ID, body), 409, "config_changed");
  });

  it.each([
    [
      "schedule",
      (body: ReturnType<typeof update>) => {
        body.schedule = "not cron";
      },
      "invalid_schedule",
    ],
    [
      "prompt",
      (body: ReturnType<typeof update>) => {
        body.blocks[0]!.prompt = "  ";
      },
      "invalid_block",
    ],
    [
      "model without agent",
      (body: ReturnType<typeof update>) => {
        body.blocks[0]!.agent = null;
      },
      "invalid_block",
    ],
    [
      "Claude effort",
      (body: ReturnType<typeof update>) => {
        body.blocks[0]!.reasoningEffort = "ultra";
      },
      "invalid_block",
    ],
  ])("rejects invalid %s without changing bytes", async (_name, mutate, code) => {
    const f = await fixture();
    const body = update(readCronJobDraft(f.context, ID));
    mutate(body);
    expectCode(() => saveCronJobDraft(f.context, ID, body), 422, code);
    expect(await readFile(f.path, "utf8")).toBe(f.text);
  });

  it("rejects malformed payloads, identity changes and unsupported action", async () => {
    const f = await fixture();
    const body = update(readCronJobDraft(f.context, ID));
    expectCode(
      () => saveCronJobDraft(f.context, ID, { ...body, configPath: "/other" }),
      400,
      "invalid_body",
    );
    expectCode(
      () =>
        saveCronJobDraft(f.context, ID, {
          ...body,
          blocks: [{ ...body.blocks[0], mode: "other" }],
        }),
      400,
      "invalid_body",
    );
    expectCode(
      () => saveCronJobDraft(f.context, ID, { ...body, blocks: [...body.blocks, body.blocks[0]] }),
      409,
      "config_changed",
    );
    expectCode(
      () => readCronJobDraft(f.context, { ...ID, triggerId: "missing" }),
      404,
      "not_found",
    );
    await writeFile(f.path, f.text.replace(SPAWN, "        send: {prompt: send only}"));
    expectCode(() => readCronJobDraft(f.context, ID), 422, "unsupported_action");
    expectCode(() => cronJobIdentity(new URLSearchParams("project=demo")), 400, "invalid_identity");
  });

  it.each([
    "        spawn: &shared {prompt: anchored}",
    "        spawn:\n          prompt: &shared anchored",
    "        spawn:\n          prompt: *sharedPrompt",
    "        spawn:\n          <<: *unrelated\n          prompt: merged",
  ])("refuses shared YAML editor targets", async (spawn) => {
    const f = await fixture(spawn);
    expect(() => readCronJobDraft(f.context, ID)).toThrow(CronJobEditError);
    expect(await readFile(f.path, "utf8")).not.toContain(".tmp.");
  });

  it("writes a registered project owner with running defaults, not bootstrap", async () => {
    const f = await fixture();
    const projectPath = join(f.root, "project.yaml");
    await writeFile(
      projectPath,
      f.text
        .replace("  demo:", "  separate:")
        .replace("server: {port: 43987}", "defaultAgent: ignored-global"),
    );
    const context = { ...f.context, registryPaths: [projectPath] };
    const id = { ...ID, projectId: "separate" };
    const draft = readCronJobDraft(context, id);
    const body = update(draft);
    body.blocks[0]!.prompt = "project owner edit";
    saveCronJobDraft(context, id, body);
    expect(await readFile(f.path, "utf8")).toBe(f.text);
    expect(await readFile(projectPath, "utf8")).toContain("project owner edit");
  });

  it("keeps a symlink and validates relative config values against its logical directory", async () => {
    const f = await fixture();
    const physicalDir = join(f.root, "elsewhere");
    await mkdir(physicalDir);
    const target = join(physicalDir, "actual.yaml");
    await writeFile(target, f.text);
    fs.unlinkSync(f.path);
    await symlink(target, f.path);
    fs.chmodSync(target, 0o600);
    const body = update(readCronJobDraft(f.context, ID));
    body.blocks[0]!.prompt = "symlink edit";
    saveCronJobDraft(f.context, ID, body);
    expect(fs.lstatSync(f.path).isSymbolicLink()).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    const parsed = parseConfigText(f.path, await readFile(target, "utf8"));
    expect(parsed.projects["demo"]!.path).toBe(join(f.root, "repo"));
  });

  it("checks content immediately before rename", async () => {
    const f = await fixture();
    const body = update(readCronJobDraft(f.context, ID));
    body.blocks[0]!.prompt = "UI edit";
    const actual = await vi.importActual<typeof fs>("node:fs");
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, data, options) => {
      actual.writeFileSync(path, data, options);
      actual.writeFileSync(f.path, f.text.replace("Audit sessions", "Other sessions"));
    });
    expectCode(() => saveCronJobDraft(f.context, ID, body), 409, "config_changed");
    expect(await readFile(f.path, "utf8")).toContain("Other sessions");
    expect(fs.readdirSync(f.root).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("rejects symlink retargeting immediately before rename without changing either target", async () => {
    const f = await fixture();
    const first = join(f.root, "first.yaml");
    const second = join(f.root, "second.yaml");
    await writeFile(first, f.text);
    await writeFile(second, f.text);
    fs.unlinkSync(f.path);
    await symlink(first, f.path);
    const body = update(readCronJobDraft(f.context, ID));
    body.blocks[0]!.prompt = "UI edit";
    const actual = await vi.importActual<typeof fs>("node:fs");
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path, data, options) => {
      actual.writeFileSync(path, data, options);
      actual.unlinkSync(f.path);
      actual.symlinkSync(second, f.path);
    });
    expectCode(() => saveCronJobDraft(f.context, ID, body), 409, "config_changed");
    expect(await readFile(first, "utf8")).toBe(f.text);
    expect(await readFile(second, "utf8")).toBe(f.text);
    expect(fs.realpathSync(f.path)).toBe(second);
    expect(fs.readdirSync(f.root).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("cleans failed rename output and leaves original bytes", async () => {
    const f = await fixture();
    const body = update(readCronJobDraft(f.context, ID));
    body.blocks[0]!.prompt = "not written";
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error("rename failure");
    });
    expectCode(() => saveCronJobDraft(f.context, ID, body), 500, "config_io");
    expect(await readFile(f.path, "utf8")).toBe(f.text);
    expect(fs.readdirSync(f.root).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("cleans an opened temp file after a write failure", async () => {
    const f = await fixture();
    const body = update(readCronJobDraft(f.context, ID));
    body.blocks[0]!.prompt = "not written";
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error("write failure");
    });
    expectCode(() => saveCronJobDraft(f.context, ID, body), 500, "config_io");
    expect(await readFile(f.path, "utf8")).toBe(f.text);
    expect(fs.readdirSync(f.root).filter((name) => name.includes(".tmp."))).toEqual([]);
  });
});

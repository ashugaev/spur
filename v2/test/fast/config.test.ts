import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadProjectConfig, resolveConfigPath } from "../../src/config.js";
import { DEFAULT_PROJECT_PREFLIGHT_PROMPT } from "../../src/preflight-contract.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];
const initialCwd = process.cwd();
const initialSpurConfig = process.env["SPUR_CONFIG"];

async function writeConfig(content: string): Promise<string> {
  return writeNamedConfig("spur.yaml", content);
}

async function writeNamedConfig(name: string, content: string): Promise<string> {
  const dir = await createTempDir("spur-fast-config-");
  tempDirs.push(dir);
  const repoPath = join(dir, "repo");
  const configPath = join(dir, name);
  await writeFile(configPath, content.replaceAll("$REPO_PATH", repoPath), "utf8");
  return configPath;
}

afterEach(async () => {
  process.chdir(initialCwd);
  if (initialSpurConfig === undefined) {
    delete process.env["SPUR_CONFIG"];
  } else {
    process.env["SPUR_CONFIG"] = initialSpurConfig;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  it("applies Spur defaults once at the config boundary", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      notify:
        source: pr-watch
        event: github:comment
        send: {}
`);

    const config = loadConfig(configPath);

    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(4310);
    expect(config.defaultAgent).toBe("claude");
    expect(config.dataDir).toContain(".spur");
    expect(config.worktreeDir).toContain(".spur/worktrees");
    expect(config.voice.provider).toBe("whisper_cpp");
    expect(config.voice.model).toBe("base");
    expect(config.voice.modelPath).toBeUndefined();
    expect(config.voice.language).toBe("auto");
    expect(config.projects["backend"]?.defaultBranch).toBe("main");
    expect(config.projects["backend"]?.sessionPrefix).toBe("backend");
    expect(config.projects["backend"]?.worktree).toBe(true);
    expect(config.projects["backend"]?.sources["pr-watch"]).toEqual({
      type: "github",
      intervalMs: 60_000,
      runOnStart: false,
    });
    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "pr-watch",
      event: "github:comment",
      send: {
        interrupt: false,
      },
    });
  });

  it("parses explicit project worktree defaults and spawn overrides", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    worktree: false
    triggers:
      review:
        source: weekday
        event: cron:tick
        spawn:
          prompt: "review this task"
          steps:
            - "research"
            - "implement"
          overrides:
            worktree: true
            defaultBranch: release
    sources:
      weekday:
        type: cron
        schedule: "* * * * *"
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.worktree).toBe(false);
    expect(config.projects["backend"]?.triggers["review"]).toEqual({
      source: "weekday",
      event: "cron:tick",
      spawn: {
        prompt: "review this task",
        steps: ["research", "implement"],
        overrides: {
          worktree: true,
          defaultBranch: "release",
        },
      },
    });
  });

  it("parses optional send prompt on triggers", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      notify:
        source: pr-watch
        event: github:changes_requested
        send:
          interrupt: true
          prompt: "Run $manager and $github. Address requested changes."
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "pr-watch",
      event: "github:changes_requested",
      send: {
        interrupt: true,
        prompt: "Run $manager and $github. Address requested changes.",
      },
    });
  });

  it("accepts github merge conflict events during config validation", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      notify:
        source: pr-watch
        event: github:merge_conflict
        send: {}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "pr-watch",
      event: "github:merge_conflict",
      send: {
        interrupt: false,
      },
    });
  });

  it("parses service sources with rule defaults and matching trigger events", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      web-watch:
        type: service
        service: web
        rules:
          crash:
            match: "SERVICE_ERROR"
    triggers:
      notify:
        source: web-watch
        event: service:crash
        send: {}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sources["web-watch"]).toEqual({
      type: "service",
      runOnStart: false,
      service: "web",
      intervalMs: 2_000,
      tailLines: 200,
      rules: {
        crash: {
          match: "SERVICE_ERROR",
          cooldownMs: 60_000,
        },
      },
    });
    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "web-watch",
      event: "service:crash",
      send: {
        interrupt: false,
      },
    });
  });

  it("rejects non-string send prompts", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      notify:
        source: pr-watch
        event: github:comment
        send:
          prompt: true
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.notify.send.prompt must be a non-empty string",
    );
  });

  it("parses project default spawn steps", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    spawn:
      steps:
        - "research"
        - "test"
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.spawn).toEqual({
      steps: ["research", "test"],
    });
  });

  it("parses a custom voice model path from the instance config", async () => {
    const configPath = await writeConfig(`
voice:
  modelPath: ~/models/ggml-small.bin

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice.modelPath).toContain("/models/ggml-small.bin");
  });

  it("parses voice provider and model with minimal config", async () => {
    const configPath = await writeConfig(`
voice:
  provider: faster_whisper
  language: auto
  model: small

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice).toEqual({
      provider: "faster_whisper",
      language: "auto",
      model: "small",
    });
  });

  it("parses azure_openai voice provider with deployment name only", async () => {
    const configPath = await writeConfig(`
voice:
  provider: azure_openai
  model: whisper

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice).toEqual({
      provider: "azure_openai",
      language: "auto",
      model: "whisper",
    });
  });

  it("keeps legacy voice configs backwards compatible", async () => {
    const configPath = await writeConfig(`
voice:
  modelPath: ~/models/ggml-base.bin
  language: ru

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice.provider).toBe("whisper_cpp");
    expect(config.voice.model).toBe("base");
    expect(config.voice.modelPath).toContain("/models/ggml-base.bin");
    expect(config.voice.language).toBe("ru");
  });

  it("rejects unsupported voice providers", async () => {
    const configPath = await writeConfig(`
voice:
  provider: whisperx

projects:
  backend:
    path: $REPO_PATH
`);

    expect(() => loadConfig(configPath)).toThrow(
      'voice.provider must be "whisper_cpp", "faster_whisper", or "azure_openai"',
    );
  });

  it("parses an optional project spawn preflight prompt", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    preflight:
      prompt: "Suggest a branch from the task and repo rules."
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.preflight).toEqual({
      prompt: "Suggest a branch from the task and repo rules.",
    });
  });

  it("defaults project spawn preflight prompt when omitted", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    preflight: {}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.preflight).toEqual({
      prompt: DEFAULT_PROJECT_PREFLIGHT_PROMPT,
    });
  });

  it("rejects removed GitHub event names during config validation", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      old-trigger:
        source: pr-watch
        event: github:review
        send: {}
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend.triggers.old-trigger.event uses unsupported event "github:review"',
    );
  });

  it("requires trigger spawn.prompt", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      weekday:
        type: cron
        schedule: "* * * * *"
    triggers:
      review:
        source: weekday
        event: cron:tick
        spawn:
          steps:
            - "continue"
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.review.spawn.prompt must be a non-empty string",
    );
  });

  it("rejects unsupported service events during config validation", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      web-watch:
        type: service
        service: web
        rules:
          crash:
            match: "SERVICE_ERROR"
    triggers:
      notify:
        source: web-watch
        event: service:missing
        send: {}
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend.triggers.notify.event uses unsupported event "service:missing"',
    );
  });

  it("rejects duplicate session prefixes across projects", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sessionPrefix: shared
  web:
    path: $REPO_PATH
    sessionPrefix: shared
`);

    expect(() => loadConfig(configPath)).toThrow(
      'sessionPrefix "shared" is duplicated in projects.api and projects.web',
    );
  });

  it("parses devServer command and autoStart", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    devServer:
      command: "pnpm dev"
      autoStart: true
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.devServer).toEqual({
      command: "pnpm dev",
      autoStart: true,
    });
  });

  it("returns undefined for devServer when the key is absent", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.devServer).toBeUndefined();
  });

  it("rejects non-boolean project worktree values", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    worktree: nope
`);

    expect(() => loadConfig(configPath)).toThrow("projects.api.worktree must be a boolean");
  });

  it("rejects non-string project preflight prompts", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    preflight:
      prompt: true
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.api.preflight.prompt must be a non-empty string",
    );
  });

  it("finds spur.yml in the current directory when no config path is passed", async () => {
    delete process.env["SPUR_CONFIG"];
    const configPath = await writeNamedConfig(
      "spur.yml",
      `
projects:
  api:
    path: $REPO_PATH
`,
    );

    process.chdir(join(configPath, ".."));
    const canonicalConfigPath = await realpath(configPath);

    expect(resolveConfigPath()).toBe(canonicalConfigPath);
    expect(loadProjectConfig().configPath).toBe(canonicalConfigPath);
  });

  it("reports the default spur.yaml path when no default config file exists", async () => {
    delete process.env["SPUR_CONFIG"];
    const dir = await createTempDir("spur-fast-config-missing-");
    tempDirs.push(dir);
    process.chdir(dir);
    const canonicalDir = await realpath(dir);

    expect(() => resolveConfigPath()).toThrow(
      `Config file not found: ${join(canonicalDir, "spur.yaml")}`,
    );
  });
});

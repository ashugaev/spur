import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSidecarLinkUrl,
  createProjectConfigScaffold,
  findProjectConfigPathInDirectory,
  loadConfig,
  loadProjectConfig,
  resolveConfigPath,
  writeProjectConfigScaffold,
} from "../../src/config.js";
import { DEFAULT_PROJECT_PREFLIGHT_PROMPT } from "../../src/preflight-contract.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];
const initialCwd = process.cwd();
const initialSpurConfig = process.env["SPUR_CONFIG"];
const WORKTREE_PATH_SHELL_TOKEN = "$" + "{worktreePathShell}";
const WORKTREE_PATH_URL_TOKEN = "$" + "{worktreePathUrl}";

async function writeConfig(content: string): Promise<string> {
  return writeNamedConfig("spur.yaml", content);
}

async function writeNamedConfig(name: string, content: string): Promise<string> {
  const dir = await createTempDir("spur-fast-config-");
  tempDirs.push(dir);
  const repoPath = join(dir, "repo");
  await mkdir(repoPath, { recursive: true });
  const configPath = join(dir, name);
  await writeFile(configPath, content.replaceAll("$REPO_PATH", repoPath), "utf8");
  return configPath;
}

async function writeProjectEnv(configPath: string, content: string): Promise<void> {
  await writeFile(join(configPath, "..", "repo", ".env"), content, "utf8");
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
    if (config.voice.provider !== "whisper_cpp" && config.voice.provider !== "faster_whisper")
      throw new Error("unexpected provider");
    expect(config.voice.modelPath).toBeUndefined();
    expect(config.voice.language).toBe("auto");
    expect(config.projects["backend"]?.defaultBranch).toBe("main");
    expect(config.projects["backend"]?.sessionPrefix).toBe("backend");
    expect(config.projects["backend"]?.worktree).toBe(true);
    expect(config.projects["backend"]?.sources["pr-watch"]).toEqual({
      type: "github",
      intervalMs: 60_000,
      runOnStart: false,
      emitExisting: false,
    });
    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "pr-watch",
      event: "github:comment",
      send: {
        interrupt: false,
      },
    });
  });

  it("accepts cursor as an instance and project default agent", async () => {
    const configPath = await writeConfig(`
defaultAgent: cursor
projects:
  backend:
    path: $REPO_PATH
    defaultAgent: cursor
`);

    const config = loadConfig(configPath);

    expect(config.defaultAgent).toBe("cursor");
    expect(config.projects["backend"]?.defaultAgent).toBe("cursor");
  });

  it("parses tag definitions and assigns a stable color when none is given", async () => {
    const configPath = await writeConfig(`
tags:
  bug:
    description: A defect to fix
  Docs:
    description: Documentation only
    color: "#abcdef"
projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);
    expect(config.tags).toHaveLength(2);
    const bug = config.tags.find((tag) => tag.name === "bug");
    expect(bug?.description).toBe("A defect to fix");
    expect(bug?.color).toMatch(/^hsl\(/);
    const docs = config.tags.find((tag) => tag.name === "docs");
    expect(docs?.color).toBe("#abcdef");
  });

  it("defaults tags to an empty list when omitted", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
`);
    expect(loadConfig(configPath).tags).toEqual([]);
  });

  it("rejects an invalid tag name", async () => {
    const configPath = await writeConfig(`
tags:
  "bad name":
    description: nope
projects:
  backend:
    path: $REPO_PATH
`);
    expect(() => loadConfig(configPath)).toThrow("tag names must match");
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
        blocks: [
          {
            prompt: "review this task",
            steps: ["research", "implement"],
            overrides: {
              worktree: true,
              defaultBranch: "release",
            },
          },
        ],
      },
    });
  });

  it("normalizes legacy scalar trigger spawn agent", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn:
          prompt: "ship it"
          agent: codex
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.triggers["kickoff"]).toEqual({
      source: "morning",
      event: "cron:tick",
      spawn: {
        blocks: [
          {
            prompt: "ship it",
            agent: "codex",
          },
        ],
      },
    });
  });

  it("parses trigger spawn block model when agent is present", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn:
          prompt: "ship it"
          agent: codex
          model: gpt-5.5
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.triggers["kickoff"]).toEqual({
      source: "morning",
      event: "cron:tick",
      spawn: {
        blocks: [
          {
            prompt: "ship it",
            agent: "codex",
            model: "gpt-5.5",
          },
        ],
      },
    });
  });

  it("rejects a trigger spawn block model without an agent", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn:
          prompt: "ship it"
          model: gpt-5.5
`);

    expect(() => loadConfig(configPath)).toThrow(/\.model requires .*\.agent/);
  });

  it("parses project defaultModel when defaultAgent is present", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    defaultAgent: codex
    defaultModel: gpt-5.5
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.defaultAgent).toBe("codex");
    expect(config.projects["backend"]?.defaultModel).toBe("gpt-5.5");
  });

  it("rejects project defaultModel without a defaultAgent", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    defaultModel: gpt-5.5
`);

    expect(() => loadConfig(configPath)).toThrow(/\.defaultModel requires .*\.defaultAgent/);
  });

  it("parses flat trigger spawn blocks and preserves per-block fields", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn:
          - agent: claude
            prompt: "Review correctness and edge cases"
            steps: ["inspect", "report"]
          - agent: claude
            prompt: "Review architecture and maintainability"
          - agent: codex
            prompt: "Review tests and implementation risks"
            steps: ["run checks", "report"]
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.triggers["kickoff"]).toEqual({
      source: "morning",
      event: "cron:tick",
      spawn: {
        blocks: [
          {
            agent: "claude",
            prompt: "Review correctness and edge cases",
            steps: ["inspect", "report"],
          },
          {
            agent: "claude",
            prompt: "Review architecture and maintainability",
          },
          {
            agent: "codex",
            prompt: "Review tests and implementation risks",
            steps: ["run checks", "report"],
          },
        ],
      },
    });
  });

  it("parses desk-group trigger spawn blocks", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawnDeskGroup: true
        spawn:
          - agent: claude
            prompt: "Review correctness"
          - agent: codex
            prompt: "Review tests"
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.triggers["kickoff"]).toEqual({
      source: "morning",
      event: "cron:tick",
      spawnDeskGroup: true,
      spawn: {
        blocks: [
          {
            agent: "claude",
            prompt: "Review correctness",
          },
          {
            agent: "codex",
            prompt: "Review tests",
          },
        ],
      },
    });
  });

  it("rejects non-boolean trigger-level spawnDeskGroup", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawnDeskGroup: "yes"
        spawn:
          - prompt: "ship it"
          - prompt: "review it"
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.kickoff.spawnDeskGroup must be a boolean",
    );
  });

  it("rejects nested trigger spawn blocks", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn:
          blocks:
            - prompt: "review it"
            - prompt: "test it"
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.kickoff.spawn.blocks is not supported; use a flat spawn array",
    );
  });

  it("rejects nested trigger spawn deskGroup", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn:
          deskGroup: true
          prompt: "ship it"
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.kickoff.spawn.deskGroup is not supported; use trigger-level spawnDeskGroup",
    );
  });

  it("rejects deskGroup with fewer than two spawn blocks", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawnDeskGroup: true
        spawn:
          - prompt: "ship it"
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.kickoff.spawnDeskGroup requires at least two spawn blocks",
    );
  });

  it("rejects deskGroup with autoComplete", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
        query: "is:pr is:open"
    triggers:
      pickup:
        source: pr-watch
        event: github:work_item.new
        spawnDeskGroup: true
        spawn:
          autoComplete: true
          prompt: "ship it"
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.pickup.spawnDeskGroup is not supported with autoComplete: true",
    );
  });

  it("rejects deskGroup blocks with incompatible workspace overrides", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawnDeskGroup: true
        spawn:
          - prompt: "ship it"
            overrides:
              worktree: false
          - prompt: "review it"
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.kickoff.spawnDeskGroup requires matching workspace overrides across spawn blocks",
    );
  });

  it("rejects plural agents on trigger spawn objects", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn:
          prompt: "ship it"
          agents: [claude, codex]
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.kickoff.spawn.agents is not supported; use flat spawn blocks",
    );
  });

  it("rejects empty flat trigger spawn blocks", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn: []
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.kickoff.spawn must be a non-empty array of spawn blocks",
    );
  });

  it("rejects agents inside flat trigger spawn blocks", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn:
          - prompt: "ship it"
            agents: [claude, codex]
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.kickoff.spawn[0].agents is not supported; use flat spawn blocks",
    );
  });

  it("parses multiple flat trigger spawn blocks on work-item events", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
        query: "is:pr is:open"
    triggers:
      pick-up:
        source: pr-watch
        event: github:work_item.new
        spawn:
          - prompt: "Take this work item."
            agent: claude
          - prompt: "Review this work item."
            agent: codex
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.triggers["pick-up"]).toEqual({
      source: "pr-watch",
      event: "github:work_item.new",
      spawn: {
        blocks: [
          {
            prompt: "Take this work item.",
            agent: "claude",
          },
          {
            prompt: "Review this work item.",
            agent: "codex",
          },
        ],
      },
    });
  });

  it("rejects trigger spawn branches with multiple flat blocks", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn:
          - prompt: "ship it"
            agent: claude
            branch: feature/task
          - prompt: "review it"
            agent: codex
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.kickoff.spawn.branch is not supported with multiple spawn blocks",
    );
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

  it("rejects spawnDeskGroup on send triggers", async () => {
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
        spawnDeskGroup: true
        send: {}
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.notify.spawnDeskGroup is only supported on spawn triggers",
    );
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

  it("accepts github PR lifecycle events during config validation", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      ready:
        source: pr-watch
        event: github:ready_for_review
        send: {}
      approved:
        source: pr-watch
        event: github:approved
        send: {}
      merged:
        source: pr-watch
        event: github:merged
        send: {}
      closed:
        source: pr-watch
        event: github:closed
        send: {}
`);

    const config = loadConfig(configPath);

    const triggers = config.projects["backend"]?.triggers;
    expect(triggers?.["ready"]).toEqual({
      source: "pr-watch",
      event: "github:ready_for_review",
      send: { interrupt: false },
    });
    expect(triggers?.["approved"]).toEqual({
      source: "pr-watch",
      event: "github:approved",
      send: { interrupt: false },
    });
    expect(triggers?.["merged"]).toEqual({
      source: "pr-watch",
      event: "github:merged",
      send: { interrupt: false },
    });
    expect(triggers?.["closed"]).toEqual({
      source: "pr-watch",
      event: "github:closed",
      send: { interrupt: false },
    });
  });

  it("rejects github PR lifecycle events for a gitlab source", async () => {
    for (const event of [
      "gitlab:ready_for_review",
      "gitlab:approved",
      "gitlab:merged",
      "gitlab:closed",
    ]) {
      const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      mr-watch:
        type: gitlab
    triggers:
      notify:
        source: mr-watch
        event: ${event}
        send: {}
`);

      expect(() => loadConfig(configPath)).toThrow(
        `projects.backend.triggers.notify.event uses unsupported event "${event}"`,
      );
    }
  });

  it("accepts gitlab source defaults and gitlab trigger events", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      mr-watch:
        type: gitlab
    triggers:
      notify:
        source: mr-watch
        event: gitlab:comment
        send: {}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sources["mr-watch"]).toEqual({
      type: "gitlab",
      intervalMs: 60_000,
      runOnStart: false,
      emitExisting: false,
    });
    expect(config.projects["backend"]?.triggers["notify"]).toEqual({
      source: "mr-watch",
      event: "gitlab:comment",
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

  it("parses project codex args", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    codexArgs:
      - -c
      - 'model_reasoning_effort="high"'
      - --enable
      - fast_mode
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.codexArgs).toEqual([
      "-c",
      'model_reasoning_effort="high"',
      "--enable",
      "fast_mode",
    ]);
  });

  it("rejects non-string project codex args", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    codexArgs:
      - -c
      - true
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.codexArgs[1] must be a non-empty string",
    );
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

    if (config.voice.provider !== "whisper_cpp" && config.voice.provider !== "faster_whisper")
      throw new Error("unexpected provider");
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
    if (config.voice.provider !== "whisper_cpp" && config.voice.provider !== "faster_whisper")
      throw new Error("unexpected provider");
    expect(config.voice.modelPath).toContain("/models/ggml-base.bin");
    expect(config.voice.language).toBe("ru");
  });

  it("parses openai_compatible voice provider with baseUrl and apiKey", async () => {
    const configPath = await writeConfig(`
voice:
  provider: openai_compatible
  model: whisper-large-v3-turbo
  baseUrl: https://api.groq.com/openai/v1/
  apiKey: GROQ_API_KEY

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice).toEqual({
      provider: "openai_compatible",
      language: "auto",
      model: "whisper-large-v3-turbo",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "GROQ_API_KEY",
    });
  });

  it("rejects openai_compatible without baseUrl", async () => {
    const configPath = await writeConfig(`
voice:
  provider: openai_compatible
  apiKey: GROQ_API_KEY

projects:
  backend:
    path: $REPO_PATH
`);

    expect(() => loadConfig(configPath)).toThrow(
      'voice.provider="openai_compatible" requires voice.baseUrl and voice.apiKey',
    );
  });

  it("rejects openai_compatible without apiKey", async () => {
    const configPath = await writeConfig(`
voice:
  provider: openai_compatible
  baseUrl: https://api.groq.com/openai/v1

projects:
  backend:
    path: $REPO_PATH
`);

    expect(() => loadConfig(configPath)).toThrow(
      'voice.provider="openai_compatible" requires voice.baseUrl and voice.apiKey',
    );
  });

  it("rejects openai_compatible with shell-unsafe apiKey", async () => {
    const configPath = await writeConfig(`
voice:
  provider: openai_compatible
  baseUrl: https://api.groq.com/openai/v1
  apiKey: "foo; cat /etc/shadow"

projects:
  backend:
    path: $REPO_PATH
`);

    expect(() => loadConfig(configPath)).toThrow(/voice\.apiKey must match/);
  });

  it("parses azure_openai voice provider with optional endpoint and apiKey overrides", async () => {
    const configPath = await writeConfig(`
voice:
  provider: azure_openai
  model: my-deployment
  endpoint: https://config-azure.example.com/
  apiKey: CUSTOM_AZURE_KEY
  apiVersion: "2024-10-21"

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice).toEqual({
      provider: "azure_openai",
      language: "auto",
      model: "my-deployment",
      endpoint: "https://config-azure.example.com",
      apiKey: "CUSTOM_AZURE_KEY",
      apiVersion: "2024-10-21",
    });
  });

  it("parses azure_openai voice provider with no optional fields (backward-compat)", async () => {
    const configPath = await writeConfig(`
voice:
  provider: azure_openai
  model: my-deployment

projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.voice).toEqual({
      provider: "azure_openai",
      language: "auto",
      model: "my-deployment",
    });
  });

  it("rejects azure_openai with shell-unsafe apiKey", async () => {
    const configPath = await writeConfig(`
voice:
  provider: azure_openai
  model: my-deployment
  apiKey: "foo; cat /etc/shadow"

projects:
  backend:
    path: $REPO_PATH
`);

    expect(() => loadConfig(configPath)).toThrow(/voice\.apiKey must match/);
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
      'voice.provider must be "whisper_cpp", "faster_whisper", "azure_openai", or "openai_compatible"',
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

  it("parses project branch naming regex", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    branchNaming:
      regex: "^feature/[a-z]+(-[a-z]+){0,3}$"
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.branchNaming).toEqual({
      regex: "^feature/[a-z]+(-[a-z]+){0,3}$",
    });
  });

  it("rejects invalid project branch naming regex", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    branchNaming:
      regex: "["
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.branchNaming.regex must be a valid JavaScript regular expression",
    );
  });

  it("rejects trigger branches that do not match project branch naming", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    branchNaming:
      regex: "^feature/[a-z]+(-[a-z]+){0,3}$"
    sources:
      work:
        type: cron
        schedule: "* * * * *"
    triggers:
      bad:
        source: work
        event: cron:tick
        spawn:
          prompt: "Run it"
          branch: bad-name
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend.triggers.bad.spawn.branch "bad-name" must match ^feature/[a-z]+(-[a-z]+){0,3}$',
    );
  });

  it("parses github source query and accepts github:work_item.new triggers", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
        query: "is:pr is:open label:spur"
    triggers:
      pick-up:
        source: pr-watch
        event: github:work_item.new
        spawn:
          prompt: "Take this work item."
          autoComplete: true
`);

    const config = loadConfig(configPath);
    expect(config.projects["backend"]?.sources["pr-watch"]).toEqual({
      type: "github",
      intervalMs: 60_000,
      runOnStart: false,
      emitExisting: false,
      query: "is:pr is:open label:spur",
    });
    expect(config.projects["backend"]?.triggers["pick-up"]).toEqual({
      source: "pr-watch",
      event: "github:work_item.new",
      spawn: {
        blocks: [
          {
            prompt: "Take this work item.",
          },
        ],
        autoComplete: true,
      },
    });
  });

  it("parses the github emitExisting flag", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
        emitExisting: true
        query: "is:pr is:open"
`);

    const config = loadConfig(configPath);
    expect(config.projects["backend"]?.sources["pr-watch"]).toMatchObject({
      type: "github",
      emitExisting: true,
    });
  });

  it("parses a sentry source with a resolved token and defaults", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      sentry-issues:
        type: sentry
        authToken: \${SENTRY_TOKEN}
        org: acme
        project: web
`);
    await writeProjectEnv(configPath, "SENTRY_TOKEN=secret-token\n");

    const config = loadConfig(configPath);
    expect(config.projects["backend"]?.sources["sentry-issues"]).toEqual({
      type: "sentry",
      runOnStart: false,
      authToken: "secret-token",
      org: "acme",
      project: "web",
      baseUrl: "https://sentry.io",
      query: "is:unresolved",
      intervalMs: 60_000,
      emitExisting: false,
    });
  });

  it("rejects a sentry source whose authToken cannot be resolved", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      sentry-issues:
        type: sentry
        authToken: \${SENTRY_TOKEN}
        org: acme
        project: web
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.sources.sentry-issues.authToken could not be resolved from the environment",
    );
  });

  it("accepts a sentry:issue.new trigger with autoComplete", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      sentry-issues:
        type: sentry
        authToken: \${SENTRY_TOKEN}
        org: acme
        project: web
    triggers:
      triage:
        source: sentry-issues
        event: sentry:issue.new
        spawn:
          prompt: "Triage {{title}}"
          autoComplete: true
`);
    await writeProjectEnv(configPath, "SENTRY_TOKEN=secret-token\n");

    const config = loadConfig(configPath);
    expect(config.projects["backend"]?.triggers["triage"]).toEqual({
      source: "sentry-issues",
      event: "sentry:issue.new",
      spawn: {
        blocks: [
          {
            prompt: "Triage {{title}}",
          },
        ],
        autoComplete: true,
      },
    });
  });

  it("rejects an unknown event for a sentry source", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      sentry-issues:
        type: sentry
        authToken: \${SENTRY_TOKEN}
        org: acme
        project: web
    triggers:
      bad:
        source: sentry-issues
        event: github:work_item.new
        spawn:
          prompt: "nope"
`);
    await writeProjectEnv(configPath, "SENTRY_TOKEN=secret-token\n");

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend.triggers.bad.event uses unsupported event "github:work_item.new"',
    );
  });

  it("rejects autoComplete on non-work-item spawn triggers", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      morning:
        type: cron
        schedule: "* * * * *"
    triggers:
      kickoff:
        source: morning
        event: cron:tick
        spawn:
          prompt: "Take this work item."
          autoComplete: true
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.kickoff.spawn.autoComplete is only supported for github:work_item.new or sentry:issue.new",
    );
  });

  it("rejects autoComplete on send triggers", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      reply:
        source: pr-watch
        event: github:comment
        send:
          autoComplete: true
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.reply.send.autoComplete is only supported on spawn triggers",
    );
  });

  it("rejects legacy autoClose on spawn triggers", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
        query: "is:pr is:open"
    triggers:
      pick-up:
        source: pr-watch
        event: github:work_item.new
        spawn:
          prompt: "Take this work item."
          autoClose: complete
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.pick-up.spawn.autoClose is not supported; use autoComplete: true",
    );
  });

  it("rejects github:work_item.new triggers when the source has no query", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
    triggers:
      pick-up:
        source: pr-watch
        event: github:work_item.new
        spawn:
          prompt: "Take this work item."
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend.triggers.pick-up.event uses unsupported event "github:work_item.new"',
    );
  });

  it("rejects multiple work-item triggers on the same github source", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sources:
      pr-watch:
        type: github
        query: "is:pr is:open"
    triggers:
      one:
        source: pr-watch
        event: github:work_item.new
        spawn:
          prompt: "first"
      two:
        source: pr-watch
        event: github:work_item.new
        spawn:
          prompt: "second"
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend: source "pr-watch" has 2 triggers subscribed to a work-item event; at most one is allowed',
    );
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

  it("parses trigger spawn selfDestruct config", async () => {
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
          prompt: "review"
          selfDestruct:
            enabled: true
            conditions: " tests pass "
`);

    const config = loadConfig(configPath);
    expect(config.projects["backend"]?.triggers["review"]).toMatchObject({
      spawn: {
        blocks: [
          {
            selfDestruct: {
              enabled: true,
              conditions: "tests pass",
            },
          },
        ],
      },
    });
  });

  it("rejects invalid trigger spawn selfDestruct config", async () => {
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
          prompt: "review"
          selfDestruct:
            enabled: "yes"
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.triggers.review.spawn.selfDestruct.enabled must be a boolean",
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

  it("parses devServer as sidecar backward compat", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    devServer:
      command: "pnpm dev"
      autoStart: true
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sidecars).toEqual({
      dev: { command: "pnpm dev", autoStart: true },
    });
  });

  it("parses sidecars block", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        autoStart: true
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
      worker:
        command: "pnpm worker"
        env:
          NODE_ENV: production
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sidecars).toEqual({
      dev: {
        command: "pnpm dev",
        autoStart: true,
        ports: {
          http: { env: "SPUR_RESERVED_PORT_DEV", start: 3000, end: 3099 },
        },
      },
      worker: { command: "pnpm worker", autoStart: false, env: { NODE_ENV: "production" } },
    });
  });

  it("resolves env placeholders in sidecar env and port url", async () => {
    process.env["SPUR_PUBLIC_HOST_TEST"] = "host.example.com";
    try {
      const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        env:
          PUBLIC_HOST: \${SPUR_PUBLIC_HOST_TEST}
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
            url: http://\${SPUR_PUBLIC_HOST_TEST}
`);

      const config = loadConfig(configPath);

      expect(config.projects["backend"]?.sidecars).toEqual({
        dev: {
          command: "pnpm dev",
          autoStart: false,
          env: { PUBLIC_HOST: "host.example.com" },
          ports: {
            http: {
              env: "SPUR_RESERVED_PORT_DEV",
              start: 3000,
              end: 3099,
              url: "http://host.example.com",
            },
          },
        },
      });
    } finally {
      delete process.env["SPUR_PUBLIC_HOST_TEST"];
    }
  });

  it("reads bare env names for sidecar env and port url from project .env", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        env:
          PUBLIC_URL: SPUR_SIDECAR_PUBLIC_URL
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
            url: SPUR_SIDECAR_PUBLIC_URL
`);
    await writeProjectEnv(configPath, "SPUR_SIDECAR_PUBLIC_URL=http://public.example.com\n");

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sidecars).toEqual({
      dev: {
        command: "pnpm dev",
        autoStart: false,
        env: { PUBLIC_URL: "http://public.example.com" },
        ports: {
          http: {
            env: "SPUR_RESERVED_PORT_DEV",
            start: 3000,
            end: 3099,
            url: "http://public.example.com",
          },
        },
      },
    });
  });

  it("parses optional workspace access block", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+100.80.107.19 \${worktreePathShell}
        - label: Web IDE
          kind: link
          value: https://code.example.com/?folder=\${worktreePathUrl}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.workspaceAccess).toEqual({
      items: [
        {
          label: "Cursor",
          kind: "copy",
          value: `cursor --remote ssh-remote+100.80.107.19 ${WORKTREE_PATH_SHELL_TOKEN}`,
        },
        {
          label: "Web IDE",
          kind: "link",
          value: `https://code.example.com/?folder=${WORKTREE_PATH_URL_TOKEN}`,
        },
      ],
    });
  });

  it("resolves env placeholders in optional workspace access", async () => {
    process.env["SPUR_WORKSPACE_HOST_TEST"] = "100.80.107.19";
    process.env["SPUR_WORKSPACE_PORT_TEST"] = "9090";
    try {
      const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+\${SPUR_WORKSPACE_HOST_TEST} \${worktreePathShell}
        - label: Web IDE
          kind: link
          value: http://\${SPUR_WORKSPACE_HOST_TEST}:\${SPUR_WORKSPACE_PORT_TEST}/?folder=\${worktreePathUrl}
`);

      const config = loadConfig(configPath);

      expect(config.projects["backend"]?.workspaceAccess).toEqual({
        items: [
          {
            label: "Cursor",
            kind: "copy",
            value: `cursor --remote ssh-remote+100.80.107.19 ${WORKTREE_PATH_SHELL_TOKEN}`,
          },
          {
            label: "Web IDE",
            kind: "link",
            value: `http://100.80.107.19:9090/?folder=${WORKTREE_PATH_URL_TOKEN}`,
          },
        ],
      });
    } finally {
      delete process.env["SPUR_WORKSPACE_HOST_TEST"];
      delete process.env["SPUR_WORKSPACE_PORT_TEST"];
    }
  });

  it("reads bare env names for optional workspace access from project .env", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+SPUR_SIDECAR_PUBLIC_HOST \${worktreePathShell}
        - label: Web IDE
          kind: link
          value: SPUR_VSCODE_WEB_URL/?folder=\${worktreePathUrl}
`);
    await writeProjectEnv(
      configPath,
      [
        "SPUR_SIDECAR_PUBLIC_HOST=100.80.107.19",
        "SPUR_VSCODE_WEB_URL=http://code.example.com:9090",
        "",
      ].join("\n"),
    );

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.workspaceAccess).toEqual({
      items: [
        {
          label: "Cursor",
          kind: "copy",
          value: `cursor --remote ssh-remote+100.80.107.19 ${WORKTREE_PATH_SHELL_TOKEN}`,
        },
        {
          label: "Web IDE",
          kind: "link",
          value: `http://code.example.com:9090/?folder=${WORKTREE_PATH_URL_TOKEN}`,
        },
      ],
    });
  });

  it("omits unresolved bare env names for optional workspace access", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+SPUR_SIDECAR_PUBLIC_HOST \${worktreePathShell}
        - label: Web IDE
          kind: link
          value: SPUR_VSCODE_WEB_URL/?folder=\${worktreePathUrl}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.workspaceAccess).toBeUndefined();
  });

  it("omits unresolved optional workspace access entries", async () => {
    delete process.env["SPUR_WORKSPACE_HOST_MISSING"];
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+\${SPUR_WORKSPACE_HOST_MISSING} \${worktreePathShell}
        - label: Web IDE
          kind: link
          value: http://\${SPUR_WORKSPACE_HOST_MISSING}:9090/?folder=\${worktreePathUrl}
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.workspaceAccess).toBeUndefined();
  });

  it("requires workspace access items", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess: {}
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.workspaceAccess.items must be an array",
    );
  });

  it("rejects invalid workspace access item kind", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Nope
          kind: shell
          value: echo hi
`);

    expect(() => loadConfig(configPath)).toThrow(
      'projects.backend.workspaceAccess.items[0].kind must be "copy" or "link"',
    );
  });

  it("omits only unresolved workspace access items", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    workspaceAccess:
      items:
        - label: Cursor
          kind: copy
          value: cursor --remote ssh-remote+SPUR_SIDECAR_PUBLIC_HOST \${worktreePathShell}
        - label: Stable docs
          kind: link
          value: https://example.com/docs
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.workspaceAccess).toEqual({
      items: [{ label: "Stable docs", kind: "link", value: "https://example.com/docs" }],
    });
  });

  it("rejects invalid sidecar port ranges", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3100
            end: 3000
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.sidecars.dev.ports.http.end must be greater than or equal to projects.backend.sidecars.dev.ports.http.start",
    );
  });

  it("rejects sidecar port urls with explicit ports", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
            url: http://host.example.com:9090
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.sidecars.dev.ports.http.url must not include an explicit port",
    );
  });

  it("accepts {port} subdomain token in sidecar port url", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
            url: https://{port}.local.intelas.com
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sidecars["dev"]?.ports?.["http"]?.url).toBe(
      "https://{port}.local.intelas.com",
    );
  });

  it("strips trailing slash from {port} subdomain url", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
            url: https://{port}.local.intelas.com/
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sidecars["dev"]?.ports?.["http"]?.url).toBe(
      "https://{port}.local.intelas.com",
    );
  });

  it("rejects {port} token combined with explicit port", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
            url: https://{port}.local.intelas.com:9090
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.sidecars.dev.ports.http.url must not include an explicit port",
    );
  });

  it("rejects {port} token combined with path", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    sidecars:
      dev:
        command: "pnpm dev"
        ports:
          http:
            env: SPUR_RESERVED_PORT_DEV
            start: 3000
            end: 3099
            url: https://{port}.local.intelas.com/app
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.backend.sidecars.dev.ports.http.url must not include a path",
    );
  });

  it("rejects both devServer and sidecars", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
    devServer:
      command: "pnpm dev"
    sidecars:
      dev:
        command: "pnpm dev"
`);

    expect(() => loadConfig(configPath)).toThrow('defines both "devServer" and "sidecars"');
  });

  it("returns empty sidecars when no sidecar or devServer key present", async () => {
    const configPath = await writeConfig(`
projects:
  backend:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.projects["backend"]?.sidecars).toEqual({});
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

  it("defaults restoreAfterReboot to false when unset", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
`);

    const config = loadConfig(configPath);

    expect(config.projects["api"]?.restoreAfterReboot).toBe(false);
  });

  it("parses explicit restoreAfterReboot true", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    restoreAfterReboot: true
`);

    const config = loadConfig(configPath);

    expect(config.projects["api"]?.restoreAfterReboot).toBe(true);
  });

  it("rejects non-boolean restoreAfterReboot values", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    restoreAfterReboot: yes
`);

    expect(() => loadConfig(configPath)).toThrow(
      "projects.api.restoreAfterReboot must be a boolean",
    );
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

  it("reports the candidate spur.yaml path when an explicit config file is missing", async () => {
    delete process.env["SPUR_CONFIG"];
    const dir = join(initialCwd, `.tmp-spur-fast-config-missing-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    tempDirs.push(dir);
    process.chdir(dir);
    const canonicalDir = await realpath(dir);

    expect(() => resolveConfigPath("spur.yaml")).toThrow(
      `Config file not found: ${join(canonicalDir, "spur.yaml")}`,
    );
  });

  it("renders a minimal project config scaffold for the current repo", async () => {
    const dir = await createTempDir("spur-fast-doctor-");
    tempDirs.push(dir);

    const scaffold = createProjectConfigScaffold(join(dir, "My Repo"), "release");

    expect(scaffold.configPath).toBe(join(dir, "My Repo", "spur.yaml"));
    expect(scaffold.projectId).toBe("my-repo");
    expect(scaffold.sessionPrefix).toBe("my-repo");
    expect(scaffold.content).toBe(
      [
        "projects:",
        "  my-repo:",
        "    path: .",
        "    defaultBranch: release",
        "    sessionPrefix: my-repo",
        "",
      ].join("\n"),
    );
  });

  it("inherits openai_compatible defaults into project mode without re-validating", async () => {
    const instancePath = await writeNamedConfig(
      "instance.yaml",
      `
voice:
  provider: openai_compatible
  model: whisper-large-v3-turbo
  baseUrl: https://api.groq.com/openai/v1
  apiKey: GROQ_API_KEY

projects:
  backend:
    path: $REPO_PATH
`,
    );
    const instance = loadConfig(instancePath);
    const projectPath = await writeNamedConfig(
      "project.yaml",
      `
projects:
  api:
    path: $REPO_PATH
`,
    );

    const project = loadProjectConfig(projectPath, instance);

    expect(project.voice).toEqual({
      provider: "openai_compatible",
      language: "auto",
      model: "whisper-large-v3-turbo",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "GROQ_API_KEY",
    });
  });

  it("writes a project config scaffold that parses as a normal local config", async () => {
    const dir = await createTempDir("spur-fast-doctor-write-");
    tempDirs.push(dir);
    const repoDir = join(dir, "repo");
    await mkdir(repoDir, { recursive: true });
    const scaffold = createProjectConfigScaffold(repoDir, "main");

    writeProjectConfigScaffold(scaffold);

    process.chdir(repoDir);
    const config = loadProjectConfig();

    expect(config.configPath).toBe(join(repoDir, "spur.yaml"));
    expect(config.projects["repo"]).toMatchObject({
      defaultBranch: "main",
      path: repoDir,
      sessionPrefix: "repo",
    });
  });

  it("checks for existing doctor config only inside the repo root", async () => {
    const dir = await createTempDir("spur-fast-doctor-parent-");
    tempDirs.push(dir);
    const repoDir = join(dir, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(dir, "spur.yaml"), "projects: {}\n", "utf8");

    expect(findProjectConfigPathInDirectory(repoDir)).toBeUndefined();

    await writeFile(join(repoDir, "spur.yaml"), "projects: {}\n", "utf8");

    expect(findProjectConfigPathInDirectory(repoDir)).toBe(join(repoDir, "spur.yaml"));
  });
});

describe("buildSidecarLinkUrl", () => {
  it("appends port with colon when template has no token", () => {
    expect(buildSidecarLinkUrl("https://host.example.com", 3000)).toBe(
      "https://host.example.com:3000",
    );
  });

  it("substitutes {port} token in subdomain", () => {
    expect(buildSidecarLinkUrl("https://{port}.local.intelas.com", 3045)).toBe(
      "https://3045.local.intelas.com",
    );
  });

  it("substitutes all {port} occurrences", () => {
    expect(buildSidecarLinkUrl("https://{port}.example.com/p/{port}", 7)).toBe(
      "https://7.example.com/p/7",
    );
  });
});

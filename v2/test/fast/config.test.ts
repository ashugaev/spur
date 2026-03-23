import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfigPath } from "../../src/config.js";
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
  beforeEach(() => {
    delete process.env["SPUR_CONFIG"];
  });

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
    expect(config.worktreeDir).toContain(".spur-worktrees");
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
          prompt: "review"
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
        prompt: "review",
        overrides: {
          worktree: true,
          defaultBranch: "release",
        },
      },
    });
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
    expect(loadConfig().configPath).toBe(canonicalConfigPath);
  });

  it("reports the default spur.yaml path when no default config file exists", async () => {
    const dir = await createTempDir("spur-fast-config-missing-");
    tempDirs.push(dir);
    process.chdir(dir);
    const canonicalDir = await realpath(dir);

    expect(() => resolveConfigPath()).toThrow(
      `Config file not found: ${join(canonicalDir, "spur.yaml")}`,
    );
  });
});

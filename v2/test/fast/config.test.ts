import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

async function writeConfig(content: string): Promise<string> {
  const dir = await createTempDir("spur-fast-config-");
  tempDirs.push(dir);
  const repoPath = join(dir, "repo");
  const configPath = join(dir, "spur.yaml");
  await writeFile(configPath, content.replaceAll("$REPO_PATH", repoPath), "utf8");
  return configPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
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
    expect(config.worktreeDir).toContain(".spur-worktrees");
    expect(config.projects["backend"]?.defaultBranch).toBe("main");
    expect(config.projects["backend"]?.sessionPrefix).toBe("backend");
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
});

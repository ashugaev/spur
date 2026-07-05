import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_PR_CLOSE_TRIGGER_ID,
  DEFAULT_PR_CLOSE_TRIGGER_PROMPT,
  describePrCloseTrigger,
  ensurePrCloseTrigger,
  findPrCloseTrigger,
  formatPrCloseTriggerInfo,
  resolveGithubSourceForPrClose,
} from "../../src/pr-close-trigger.js";
import { loadConfig } from "../../src/config.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

async function writeConfig(content: string): Promise<string> {
  const dir = await createTempDir("spur-fast-pr-close-");
  tempDirs.push(dir);
  const repoPath = join(dir, "repo");
  await mkdir(repoPath, { recursive: true });
  const configPath = join(dir, "spur.yaml");
  await writeFile(configPath, content.replaceAll("$REPO_PATH", repoPath), "utf8");
  return configPath;
}

describe("pr-close-trigger", () => {
  const originalProject = process.env["SPUR_PROJECT"];

  afterEach(async () => {
    if (originalProject === undefined) {
      delete process.env["SPUR_PROJECT"];
    } else {
      process.env["SPUR_PROJECT"] = originalProject;
    }
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("findPrCloseTrigger returns an existing github:closed send trigger", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sources:
      gh:
        type: github
    triggers:
      gh-closed:
        source: gh
        event: github:closed
        send:
          prompt: "custom close prompt"
`);

    const project = loadConfig(configPath).projects.api!;
    expect(findPrCloseTrigger(project)).toEqual({
      triggerId: "gh-closed",
      config: {
        source: "gh",
        event: "github:closed",
        send: {
          interrupt: false,
          prompt: "custom close prompt",
        },
      },
    });
  });

  it("resolveGithubSourceForPrClose prefers the source from an existing github send trigger", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sources:
      gh:
        type: github
      other:
        type: github
    triggers:
      gh-comment:
        source: gh
        event: github:comment
        send: {}
`);

    const project = loadConfig(configPath).projects.api!;
    expect(resolveGithubSourceForPrClose(project)).toBe("gh");
  });

  it("ensurePrCloseTrigger creates gh-closed when missing", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sources:
      gh:
        type: github
    triggers:
      gh-comment:
        source: gh
        event: github:comment
        send: {}
`);

    const result = ensurePrCloseTrigger({ configPath, projectId: "api" });
    expect(result).toMatchObject({
      ok: true,
      projectId: "api",
      triggerId: DEFAULT_PR_CLOSE_TRIGGER_ID,
      sourceId: "gh",
      event: "github:closed",
      prompt: DEFAULT_PR_CLOSE_TRIGGER_PROMPT,
      created: true,
    });

    const reloaded = loadConfig(configPath).projects.api!;
    expect(findPrCloseTrigger(reloaded)?.triggerId).toBe(DEFAULT_PR_CLOSE_TRIGGER_ID);
  });

  it("ensurePrCloseTrigger is idempotent and reports existing trigger info", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sources:
      gh:
        type: github
    triggers:
      notify-closed:
        source: gh
        event: github:closed
        send:
          prompt: "existing prompt"
`);

    const result = ensurePrCloseTrigger({ configPath, projectId: "api" });
    expect(result).toMatchObject({
      triggerId: "notify-closed",
      sourceId: "gh",
      prompt: "existing prompt",
      created: false,
    });

    const raw = parseYaml(readFileSync(configPath, "utf8")) as {
      projects: { api: { triggers: Record<string, unknown> } };
    };
    expect(Object.keys(raw.projects.api.triggers)).toEqual(["notify-closed"]);
  });

  it("describePrCloseTrigger returns info for an existing trigger", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sources:
      gh:
        type: github
    triggers:
      gh-closed:
        source: gh
        event: github:closed
        send:
          prompt: "describe me"
`);

    expect(describePrCloseTrigger({ configPath, projectId: "api" })).toMatchObject({
      triggerId: "gh-closed",
      prompt: "describe me",
      created: false,
    });
  });

  it("describePrCloseTrigger fails when trigger is missing", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sources:
      gh:
        type: github
    triggers: {}
`);

    expect(() => describePrCloseTrigger({ configPath, projectId: "api" })).toThrow(
      "No github:closed trigger",
    );
  });

  it("ensurePrCloseTrigger resolves project from SPUR_PROJECT", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sources:
      gh:
        type: github
    triggers: {}
`);

    process.env["SPUR_PROJECT"] = "api";
    const result = ensurePrCloseTrigger({ configPath });
    expect(result.projectId).toBe("api");
    expect(result.created).toBe(true);
  });

  it("formatPrCloseTriggerInfo renders created and existing states", () => {
    expect(
      formatPrCloseTriggerInfo({
        ok: true,
        projectId: "api",
        configPath: "/tmp/spur.yaml",
        triggerId: "gh-closed",
        sourceId: "gh",
        event: "github:closed",
        prompt: "close it",
        created: true,
      }),
    ).toContain("Created github:closed trigger");
    expect(
      formatPrCloseTriggerInfo({
        ok: true,
        projectId: "api",
        configPath: "/tmp/spur.yaml",
        triggerId: "gh-closed",
        sourceId: "gh",
        event: "github:closed",
        prompt: "close it",
        created: false,
      }),
    ).toContain("Already configured");
  });
});

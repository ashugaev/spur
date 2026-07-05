import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PR_CLOSE_TRIGGER_ID,
  DEFAULT_PR_CLOSE_TRIGGER_PROMPT,
  describePrCloseTrigger,
  ensurePrCloseTrigger,
  findPrCloseTrigger,
  formatPrCloseTriggerInfo,
  resolveGithubSourceForPrClose,
} from "../../src/pr-close-trigger.js";
import { loadProjectConfig } from "../../src/config.js";
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
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

    const project = loadProjectConfig(configPath).projects["api"];
    if (project === undefined) {
      throw new Error("expected api project");
    }
    expect(findPrCloseTrigger(project)).toMatchObject({
      triggerId: "gh-closed",
      sourceId: "gh",
      kind: "send",
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

  it("findPrCloseTrigger returns an existing github:closed spawn trigger", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sources:
      gh:
        type: github
    triggers:
      gh-closed-spawn:
        source: gh
        event: github:closed
        spawn:
          prompt: "spawn on close"
`);

    const project = loadProjectConfig(configPath).projects["api"];
    if (project === undefined) {
      throw new Error("expected api project");
    }
    expect(findPrCloseTrigger(project)).toMatchObject({
      triggerId: "gh-closed-spawn",
      sourceId: "gh",
      kind: "spawn",
    });
  });

  it("resolveGithubSourceForPrClose prefers a github send trigger source", async () => {
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

    const project = loadProjectConfig(configPath).projects["api"];
    if (project === undefined) {
      throw new Error("expected api project");
    }
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
      kind: "send",
      prompt: DEFAULT_PR_CLOSE_TRIGGER_PROMPT,
      created: true,
    });

    const reloaded = loadProjectConfig(configPath).projects["api"];
    if (reloaded === undefined) {
      throw new Error("expected api project");
    }
    expect(findPrCloseTrigger(reloaded)?.triggerId).toBe(DEFAULT_PR_CLOSE_TRIGGER_ID);
  });

  it("ensurePrCloseTrigger preserves existing YAML comments when creating a trigger", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    # keep this comment
    sources:
      gh:
        type: github
    triggers:
      gh-comment:
        source: gh
        event: github:comment
        send: {}
`);

    ensurePrCloseTrigger({ configPath, projectId: "api" });
    const written = await readFile(configPath, "utf8");
    expect(written).toContain("# keep this comment");
    expect(written).toContain("gh-closed:");
  });

  it("ensurePrCloseTrigger is idempotent for send triggers", async () => {
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
      kind: "send",
      prompt: "existing prompt",
      created: false,
    });

    const reloaded = loadProjectConfig(configPath).projects["api"];
    if (reloaded === undefined) {
      throw new Error("expected api project");
    }
    expect(Object.keys(reloaded.triggers)).toEqual(["notify-closed"]);
  });

  it("ensurePrCloseTrigger treats an existing spawn trigger as already configured", async () => {
    const configPath = await writeConfig(`
projects:
  api:
    path: $REPO_PATH
    sources:
      gh:
        type: github
    triggers:
      gh-closed-spawn:
        source: gh
        event: github:closed
        spawn:
          prompt: "spawn on close"
`);

    const result = ensurePrCloseTrigger({ configPath, projectId: "api" });
    expect(result).toMatchObject({
      triggerId: "gh-closed-spawn",
      kind: "spawn",
      created: false,
    });

    const reloaded = loadProjectConfig(configPath).projects["api"];
    if (reloaded === undefined) {
      throw new Error("expected api project");
    }
    expect(Object.keys(reloaded.triggers)).toEqual(["gh-closed-spawn"]);
  });

  it("describePrCloseTrigger reports runtime default prompt for send triggers without send.prompt", async () => {
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
        send: {}
`);

    const result = describePrCloseTrigger({ configPath, projectId: "api" });
    expect(result.prompt).toContain("closed without merging");
    expect(result.prompt).not.toBe(DEFAULT_PR_CLOSE_TRIGGER_PROMPT);
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
        kind: "send",
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
        kind: "send",
        prompt: "close it",
        created: false,
      }),
    ).toContain("Already configured");
  });
});

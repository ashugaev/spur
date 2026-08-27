import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_NESTED_ARTIFACT_ROWS,
  deleteSessionArtifactsExcept,
  listSessionArtifacts,
  parseArtifactRelativePath,
  readSessionArtifact,
  setSessionArtifactOrigin,
  setSessionArtifactUserAdded,
  sessionArtifactsDir,
} from "../../src/session-artifacts.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDataDir(): Promise<string> {
  const dir = await createTempDir("spur-artifacts-");
  tempDirs.push(dir);
  return dir;
}

describe("session artifact origins", () => {
  it("defaults ad-hoc artifacts to agent-owned and preserves automatic plus user-added metadata", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-a1";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "report.txt"), "hello", "utf8");
    await writeFile(join(dir, "agent-history.jsonl"), '{"ok":true}\n', "utf8");
    await writeFile(join(dir, "uploaded.png"), "png", "utf8");

    setSessionArtifactOrigin(dataDir, sessionId, "agent-history.jsonl", "automatic");
    setSessionArtifactUserAdded(dataDir, sessionId, "uploaded.png", true);

    expect(listSessionArtifacts(dataDir, sessionId).artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "report.txt",
          origin: "intentional",
          addedByUser: false,
        }),
        expect.objectContaining({
          id: "agent-history.jsonl",
          origin: "automatic",
          addedByUser: false,
        }),
        expect.objectContaining({
          id: "uploaded.png",
          origin: "intentional",
          addedByUser: true,
        }),
      ]),
    );
  });

  it("classifies user-added attachments by mime type", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-a2";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "shot.png"), "png-bytes", "utf8");
    await writeFile(join(dir, "report.pdf"), "%PDF", "utf8");
    await writeFile(join(dir, "notes.txt"), "hello", "utf8");

    setSessionArtifactUserAdded(dataDir, sessionId, "shot.png", true);
    setSessionArtifactUserAdded(dataDir, sessionId, "report.pdf", true);
    setSessionArtifactUserAdded(dataDir, sessionId, "notes.txt", true);

    expect(listSessionArtifacts(dataDir, sessionId).artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "shot.png", kind: "image", addedByUser: true }),
        expect.objectContaining({ id: "report.pdf", kind: "download", addedByUser: true }),
        expect.objectContaining({ id: "notes.txt", kind: "text", addedByUser: true }),
      ]),
    );
  });
});

describe("session artifact kinds", () => {
  it("classifies text extensions as text and binary as download", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-a1";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes.txt"), "hello", "utf8");
    await writeFile(join(dir, "report.imd"), "# Title", "utf8");
    await writeFile(join(dir, "app.log"), "line", "utf8");
    await writeFile(join(dir, "readme.md"), "# Readme", "utf8");
    await writeFile(join(dir, "config.json"), "{}", "utf8");
    await writeFile(join(dir, "report.html"), "<h1>Report</h1>", "utf8");
    await writeFile(join(dir, "legacy.htm"), "<h1>Legacy</h1>", "utf8");
    await writeFile(join(dir, "data.bin"), "\x00\x01", "utf8");

    const artifacts = listSessionArtifacts(dataDir, sessionId).artifacts;
    const byId = Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact]));

    expect(byId["notes.txt"]).toMatchObject({
      kind: "text",
      mimeType: "text/plain; charset=utf-8",
    });
    expect(byId["report.imd"]).toMatchObject({
      kind: "text",
      mimeType: "text/plain; charset=utf-8",
    });
    expect(byId["app.log"]).toMatchObject({
      kind: "text",
      mimeType: "text/plain; charset=utf-8",
    });
    expect(byId["readme.md"]).toMatchObject({
      kind: "text",
      mimeType: "text/markdown; charset=utf-8",
    });
    expect(byId["config.json"]).toMatchObject({
      kind: "text",
      mimeType: "application/json",
    });
    expect(byId["report.html"]).toMatchObject({
      kind: "text",
      mimeType: "text/html; charset=utf-8",
    });
    expect(byId["legacy.htm"]).toMatchObject({
      kind: "text",
      mimeType: "text/html; charset=utf-8",
    });
    expect(byId["data.bin"]).toMatchObject({
      kind: "download",
      mimeType: "application/octet-stream",
    });
  });
});

describe("nested artifact listing", () => {
  it("lists files in subfolders under their relative path", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-nested-1";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(join(dir, "design"), { recursive: true });
    await writeFile(join(dir, "design", "design-spec.md"), "# Spec", "utf8");
    await writeFile(join(dir, "shot.png"), "png", "utf8");

    const { artifacts, truncated } = listSessionArtifacts(dataDir, sessionId);
    expect(truncated).toBe(false);
    const byId = Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact]));
    expect(byId["design/design-spec.md"]).toMatchObject({
      id: "design/design-spec.md",
      name: "design/design-spec.md",
    });
    expect(byId["shot.png"]).toMatchObject({ id: "shot.png", name: "shot.png" });
  });

  it("keys origin metadata by relative path", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-nested-2";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(join(dir, "design"), { recursive: true });
    await writeFile(join(dir, "design", "design-spec.md"), "# Spec", "utf8");

    setSessionArtifactOrigin(dataDir, sessionId, "design/design-spec.md", "automatic");
    setSessionArtifactUserAdded(dataDir, sessionId, "design/design-spec.md", true);

    const { artifacts } = listSessionArtifacts(dataDir, sessionId);
    expect(artifacts).toEqual([
      expect.objectContaining({
        id: "design/design-spec.md",
        origin: "automatic",
        addedByUser: true,
      }),
    ]);
  });

  it("terminates on a symlink loop and lists each file once", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-loop";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(join(dir, "loop"), { recursive: true });
    await writeFile(join(dir, "loop", "file.txt"), "hi", "utf8");
    await symlink(join(dir, "loop"), join(dir, "loop", "self"), "dir");

    const { artifacts, truncated } = listSessionArtifacts(dataDir, sessionId);
    expect(truncated).toBe(false);
    expect(artifacts.map((artifact) => artifact.id)).toEqual(["loop/file.txt"]);
  });

  it("skips a symlink that points outside the artifacts root", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-escape";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(dir, { recursive: true });
    const outside = join(dataDir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(dir, "evil"), "file");

    const { artifacts } = listSessionArtifacts(dataDir, sessionId);
    expect(artifacts.map((artifact) => artifact.id)).not.toContain("evil");
  });

  it("lists each root file once when a symlink points at the artifacts root", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-self-root";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "x.md"), "hi", "utf8");
    await symlink(dir, join(dir, "self"), "dir");

    const { artifacts } = listSessionArtifacts(dataDir, sessionId);
    expect(artifacts.map((artifact) => artifact.id)).toEqual(["x.md"]);
  });

  it("lists every depth-1 file when the nested walk truncates", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-depth1-uncapped";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(dir, { recursive: true });

    const depth1Count = 400;
    for (let index = 0; index < depth1Count; index++) {
      await writeFile(join(dir, `root-${String(index).padStart(4, "0")}.txt`), "x", "utf8");
    }
    const nestedDirs = 10;
    const filesPerDir = 500; // 5,000 nested files total, well past both nested budgets
    for (let dirIndex = 0; dirIndex < nestedDirs; dirIndex++) {
      const nestedDir = join(dir, `nested-${dirIndex}`);
      await mkdir(nestedDir, { recursive: true });
      for (let fileIndex = 0; fileIndex < filesPerDir; fileIndex++) {
        await writeFile(join(nestedDir, `f-${fileIndex}.txt`), "x", "utf8");
      }
    }

    const { artifacts, truncated } = listSessionArtifacts(dataDir, sessionId);
    expect(truncated).toBe(true);
    const depth1Ids = artifacts.filter((artifact) => !artifact.id.includes("/"));
    expect(depth1Ids).toHaveLength(depth1Count);
    const nestedIds = artifacts.filter((artifact) => artifact.id.includes("/"));
    expect(nestedIds).toHaveLength(MAX_NESTED_ARTIFACT_ROWS);
  });

  it("caps nested rows and reports truncation", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-nested-cap";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    const nestedDir = join(dir, "nested");
    await mkdir(nestedDir, { recursive: true });
    const nestedCount = MAX_NESTED_ARTIFACT_ROWS + 50;
    for (let index = 0; index < nestedCount; index++) {
      await writeFile(join(nestedDir, `f-${String(index).padStart(4, "0")}.txt`), "x", "utf8");
    }

    const { artifacts, truncated } = listSessionArtifacts(dataDir, sessionId);
    expect(truncated).toBe(true);
    expect(artifacts).toHaveLength(MAX_NESTED_ARTIFACT_ROWS);

    const smallDataDir = await newDataDir();
    const smallSessionId = "api-nested-small";
    const smallDir = sessionArtifactsDir(smallDataDir, smallSessionId);
    await mkdir(join(smallDir, "notes"), { recursive: true });
    for (let index = 0; index < 3; index++) {
      await writeFile(join(smallDir, `root-${index}.txt`), "x", "utf8");
    }
    for (let index = 0; index < 7; index++) {
      await writeFile(join(smallDir, "notes", `n-${index}.txt`), "x", "utf8");
    }
    const small = listSessionArtifacts(smallDataDir, smallSessionId);
    expect(small.truncated).toBe(false);
    expect(small.artifacts).toHaveLength(10);
  });
});

describe("artifact id validation", () => {
  it("rejects traversal, absolute, backslash and NUL artifact ids", () => {
    const badIds = [
      "../escape",
      "/etc/passwd",
      "a\\b",
      `a${"\u0000"}b`,
      ".spur-artifacts.json",
      ".",
      "..",
      "",
      "a//b",
    ];
    for (const badId of badIds) {
      expect(parseArtifactRelativePath(badId)).toBeNull();
    }
  });

  it("refuses to read a symlink that resolves outside the artifacts root", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-read-escape";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(dir, { recursive: true });
    const outside = join(dataDir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "passwd"), "root:x", "utf8");
    await symlink(join(outside, "passwd"), join(dir, "evil"), "file");

    expect(readSessionArtifact(dataDir, sessionId, "evil")).toBeNull();
  });
});

describe("session artifact cleanup", () => {
  it("deletes nested files and prunes emptied directories", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-cleanup-1";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(join(dir, "design"), { recursive: true });
    await mkdir(join(dir, "notes"), { recursive: true });
    await mkdir(join(dir, "deep", "a", "b"), { recursive: true });
    await writeFile(join(dir, "shot.png"), "png", "utf8");
    await writeFile(join(dir, "design", "design-spec.md"), "spec", "utf8");
    await writeFile(join(dir, "notes", "scratch.md"), "scratch", "utf8");
    await writeFile(join(dir, "deep", "a", "b", "buried.md"), "buried", "utf8");

    deleteSessionArtifactsExcept(dataDir, sessionId, ["shot.png"]);

    const { artifacts } = listSessionArtifacts(dataDir, sessionId);
    expect(artifacts.map((artifact) => artifact.id)).toEqual(["shot.png"]);
    // The invariant this cleanup owns: no emptied directory is left behind, at any depth.
    expect(existsSync(join(dir, "design"))).toBe(false);
    expect(existsSync(join(dir, "notes"))).toBe(false);
    expect(existsSync(join(dir, "deep"))).toBe(false);
    expect(existsSync(join(dir, "deep", "a"))).toBe(false);
    expect(existsSync(join(dir, "deep", "a", "b"))).toBe(false);
  });

  it("keeps the directory holding a nested kept file", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-cleanup-2";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(join(dir, "design"), { recursive: true });
    await mkdir(join(dir, "notes"), { recursive: true });
    await writeFile(join(dir, "design", "design-spec.md"), "spec", "utf8");
    await writeFile(join(dir, "design", "scratch.md"), "scratch", "utf8");
    await writeFile(join(dir, "notes", "old.md"), "old", "utf8");

    deleteSessionArtifactsExcept(dataDir, sessionId, ["design/design-spec.md"]);

    const { artifacts } = listSessionArtifacts(dataDir, sessionId);
    expect(artifacts.map((artifact) => artifact.id)).toEqual(["design/design-spec.md"]);
    // "design/" is kept — it still holds the kept file — but "notes/" is emptied and pruned.
    expect(existsSync(join(dir, "design"))).toBe(true);
    expect(existsSync(join(dir, "design", "design-spec.md"))).toBe(true);
    expect(existsSync(join(dir, "design", "scratch.md"))).toBe(false);
    expect(existsSync(join(dir, "notes"))).toBe(false);
  });
});

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listSessionArtifacts,
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

    expect(listSessionArtifacts(dataDir, sessionId)).toEqual(
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
    await writeFile(join(dir, "data.bin"), "\x00\x01", "utf8");

    const artifacts = listSessionArtifacts(dataDir, sessionId);
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
    expect(byId["data.bin"]).toMatchObject({
      kind: "download",
      mimeType: "application/octet-stream",
    });
  });
});

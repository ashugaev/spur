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

    expect(listSessionArtifacts(dataDir, sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "shot.png", kind: "image", addedByUser: true }),
        expect.objectContaining({ id: "report.pdf", kind: "download", addedByUser: true }),
        expect.objectContaining({ id: "notes.txt", kind: "download", addedByUser: true }),
      ]),
    );
  });
});

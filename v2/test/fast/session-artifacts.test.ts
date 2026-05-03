import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listSessionArtifacts,
  setSessionArtifactOrigin,
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
  it("defaults ad-hoc artifacts to intentional and preserves automatic metadata", async () => {
    const dataDir = await newDataDir();
    const sessionId = "api-a1";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "report.txt"), "hello", "utf8");
    await writeFile(join(dir, "agent-history.jsonl"), '{"ok":true}\n', "utf8");

    setSessionArtifactOrigin(dataDir, sessionId, "agent-history.jsonl", "automatic");

    expect(listSessionArtifacts(dataDir, sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "report.txt",
          origin: "intentional",
        }),
        expect.objectContaining({
          id: "agent-history.jsonl",
          origin: "automatic",
        }),
      ]),
    );
  });
});

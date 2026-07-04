import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimAvailableBacklogItem,
  readAvailableBacklogItems,
  replaceAvailableBacklogItems,
} from "../../src/metadata.js";
import type { AvailableBacklogItem } from "../../src/types.js";

const tempDirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spur-backlog-metadata-"));
  tempDirs.push(dir);
  return dir;
}

function item(overrides: Partial<AvailableBacklogItem> = {}): AvailableBacklogItem {
  return {
    provider: "jira",
    projectId: "api",
    backlogId: "features",
    externalId: "10001",
    key: "WEB-17",
    title: "Fix checkout",
    url: "https://jira.example.com/browse/WEB-17",
    fetchedAt: "2026-06-16T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("backlog metadata", () => {
  it("claims an available item once and removes it from available backlog", async () => {
    const dataDir = await tempDataDir();
    replaceAvailableBacklogItems(dataDir, "api", "features", [item()]);

    expect(readAvailableBacklogItems(dataDir, "api", "features")).toEqual([item()]);
    expect(claimAvailableBacklogItem(dataDir, "api", "features", "10001")).toEqual(item());
    expect(readAvailableBacklogItems(dataDir, "api", "features")).toEqual([]);
    expect(claimAvailableBacklogItem(dataDir, "api", "features", "10001")).toBeNull();
  });

  it("does not re-add claimed items on later polls", async () => {
    const dataDir = await tempDataDir();
    replaceAvailableBacklogItems(dataDir, "api", "features", [item()]);
    expect(claimAvailableBacklogItem(dataDir, "api", "features", "10001")).not.toBeNull();

    replaceAvailableBacklogItems(dataDir, "api", "features", [
      item({ fetchedAt: "2026-06-16T12:05:00.000Z" }),
    ]);

    expect(readAvailableBacklogItems(dataDir, "api", "features")).toEqual([]);
  });
});

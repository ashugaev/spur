import { mkdirSync, writeFileSync } from "node:fs";
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
    position: 0,
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

  it("reads items back in fetch/position order, not externalId or fetchedAt order", async () => {
    const dataDir = await tempDataDir();
    replaceAvailableBacklogItems(dataDir, "api", "features", [
      item({ externalId: "30003", key: "WEB-3", fetchedAt: "2026-06-16T12:02:00.000Z", position: 2 }),
      item({ externalId: "10001", key: "WEB-1", fetchedAt: "2026-06-16T12:00:00.000Z", position: 0 }),
      item({ externalId: "20002", key: "WEB-2", fetchedAt: "2026-06-16T12:01:00.000Z", position: 1 }),
    ]);

    expect(readAvailableBacklogItems(dataDir, "api", "features").map((i) => i.externalId)).toEqual(
      ["10001", "20002", "30003"],
    );
  });

  it("skips a persisted item missing position while still reading valid items", async () => {
    const dataDir = await tempDataDir();
    const path = join(dataDir, "source-state", "available-backlog", "api", "features.json");
    mkdirSync(join(dataDir, "source-state", "available-backlog", "api"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        items: [
          item({ externalId: "10001", position: 0 }),
          { ...item({ externalId: "20002" }), position: undefined },
        ],
      }),
      "utf-8",
    );

    expect(readAvailableBacklogItems(dataDir, "api", "features").map((i) => i.externalId)).toEqual(
      ["10001"],
    );
  });
});

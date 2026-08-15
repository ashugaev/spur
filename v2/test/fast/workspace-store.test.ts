import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSession } from "../../src/metadata.js";
import type { SessionRecord } from "../../src/types.js";
import {
  deleteWorkspaceState,
  readWorkspaceState,
  resolveWorkspaceState,
  writeWorkspaceState,
} from "../../src/workspace-store.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDataDir(): Promise<string> {
  const dir = await createTempDir("spur-workspace-store-");
  tempDirs.push(dir);
  return dir;
}

function baseSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: "api-1",
    project: "api",
    workspaceId: "api-1",
    agent: "claude",
    prompt: "do the thing",
    branch: "spur/api-1",
    worktree: true,
    worktreePath: "/tmp/does-not-exist",
    tmuxSession: "api-1",
    launchCommand: "claude",
    status: "running",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("readWorkspaceState", () => {
  it("returns null when no file exists", async () => {
    const dataDir = await newDataDir();
    expect(readWorkspaceState(dataDir, "api-1")).toBeNull();
  });

  it("returns null for a corrupt file instead of throwing", async () => {
    const dataDir = await newDataDir();
    writeWorkspaceState(dataDir, "api-1", { slots: { title: "t", links: [] } });
    const path = join(dataDir, "workspaces", "api-1.json");
    writeFileSync(path, "{ not json", "utf-8");
    expect(readWorkspaceState(dataDir, "api-1")).toBeNull();
  });

  // Valid JSON of the wrong shape is the dangerous case: it parses, so a cast
  // would hand a number to deriveSessionSlots, which throws inside
  // enrichDashboard — and that runs in the dashboard tick's Promise.all, so
  // one bad file would stall the tick for every session.
  it("drops a slots value of the wrong shape instead of passing it through", async () => {
    const dataDir = await newDataDir();
    const path = join(dataDir, "workspaces", "api-1.json");
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    writeFileSync(path, JSON.stringify({ slots: 5 }), "utf-8");
    expect(readWorkspaceState(dataDir, "api-1")).toEqual({});
  });

  it("drops slots whose links are not a list, and keeps a well-formed sibling field", async () => {
    const dataDir = await newDataDir();
    const path = join(dataDir, "workspaces", "api-1.json");
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        slots: { title: "t", links: "nope" },
        pr: { number: 7, repo: "acme/api", url: "https://x/7" },
      }),
      "utf-8",
    );
    expect(readWorkspaceState(dataDir, "api-1")).toEqual({
      pr: { number: 7, repo: "acme/api", url: "https://x/7" },
    });
  });

  it("drops a pr binding missing a field", async () => {
    const dataDir = await newDataDir();
    const path = join(dataDir, "workspaces", "api-1.json");
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    writeFileSync(path, JSON.stringify({ pr: { number: 7, repo: "acme/api" } }), "utf-8");
    expect(readWorkspaceState(dataDir, "api-1")).toEqual({});
  });

  it("accepts only true as the manual title override marker", async () => {
    const dataDir = await newDataDir();
    const path = join(dataDir, "workspaces", "api-1.json");
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    writeFileSync(path, JSON.stringify({ manualTitleOverride: "true" }), "utf-8");
    expect(readWorkspaceState(dataDir, "api-1")).toEqual({});

    writeFileSync(path, JSON.stringify({ manualTitleOverride: true }), "utf-8");
    expect(readWorkspaceState(dataDir, "api-1")).toEqual({ manualTitleOverride: true });
  });

  it("keeps only well-formed links and tags", async () => {
    const dataDir = await newDataDir();
    const path = join(dataDir, "workspaces", "api-1.json");
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        slots: {
          title: 5,
          links: [{ label: "pr", url: "https://x" }, { label: 1, url: "https://y" }, "junk"],
          tags: ["bug", 7],
        },
      }),
      "utf-8",
    );
    expect(readWorkspaceState(dataDir, "api-1")).toEqual({
      slots: { links: [{ label: "pr", url: "https://x" }], tags: ["bug"] },
    });
  });
});

describe("writeWorkspaceState / readWorkspaceState round-trip", () => {
  it("round-trips slots, pr, and the manual title override marker", async () => {
    const dataDir = await newDataDir();
    writeWorkspaceState(dataDir, "api-1", {
      slots: { title: "My title", links: [{ label: "pr", url: "https://x" }], tags: ["bug"] },
      pr: { number: 42, repo: "acme/api", url: "https://github.com/acme/api/pull/42" },
      manualTitleOverride: true,
    });
    const state = readWorkspaceState(dataDir, "api-1");
    expect(state?.slots?.title).toBe("My title");
    expect(state?.pr?.number).toBe(42);
    expect(state?.manualTitleOverride).toBe(true);
  });

  it("omits absent fields rather than writing them as null/undefined", async () => {
    const dataDir = await newDataDir();
    writeWorkspaceState(dataDir, "api-1", { slots: { title: "t", links: [] } });
    const raw = JSON.parse(
      readFileSync(join(dataDir, "workspaces", "api-1.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect("pr" in raw).toBe(false);
  });

  it("writes atomically via tmp file + rename, leaving no stray tmp files and always valid JSON", async () => {
    const dataDir = await newDataDir();
    writeWorkspaceState(dataDir, "api-1", { slots: { title: "one", links: [] } });
    writeWorkspaceState(dataDir, "api-1", { slots: { title: "two", links: [] } });
    const dir = join(dataDir, "workspaces");
    const entries = readdirSync(dir);
    expect(entries).toEqual(["api-1.json"]);
    // The final file must always be complete, valid JSON: no partial write
    // can ever be observed by another reader (tmp+rename, not truncate+write).
    expect(() => JSON.parse(readFileSync(join(dir, "api-1.json"), "utf-8"))).not.toThrow();
    expect(readWorkspaceState(dataDir, "api-1")?.slots?.title).toBe("two");
  });
});

describe("deleteWorkspaceState", () => {
  it("removes the file", async () => {
    const dataDir = await newDataDir();
    writeWorkspaceState(dataDir, "api-1", { slots: { title: "t", links: [] } });
    deleteWorkspaceState(dataDir, "api-1");
    expect(readWorkspaceState(dataDir, "api-1")).toBeNull();
  });

  it("is a no-op when no file exists", async () => {
    const dataDir = await newDataDir();
    expect(() => deleteWorkspaceState(dataDir, "api-1")).not.toThrow();
  });
});

describe("resolveWorkspaceState", () => {
  it("prefers the workspace file when it exists", async () => {
    const dataDir = await newDataDir();
    const owner = baseSession({ slots: { title: "legacy", links: [] } });
    writeSession(dataDir, owner);
    writeWorkspaceState(dataDir, "api-1", { slots: { title: "from file", links: [] } });
    const resolved = resolveWorkspaceState(dataDir, owner);
    expect(resolved.slots?.title).toBe("from file");
  });

  it("falls back to the owner record's slots/pr when no file exists (legacy read)", async () => {
    const dataDir = await newDataDir();
    const owner = baseSession({
      slots: { title: "legacy title", links: [] },
      pr: { number: 7, repo: "acme/api", url: "https://github.com/acme/api/pull/7" },
    });
    const resolved = resolveWorkspaceState(dataDir, owner);
    expect(resolved.slots?.title).toBe("legacy title");
    expect(resolved.pr?.number).toBe(7);
  });

  it("resolves a sibling record to its owner's legacy fields via one extra read", async () => {
    const dataDir = await newDataDir();
    const owner = baseSession({ slots: { title: "owner title", links: [] } });
    writeSession(dataDir, owner);
    const sibling = baseSession({ id: "api-2", workspaceId: "api-1" });
    const resolved = resolveWorkspaceState(dataDir, sibling);
    expect(resolved.slots?.title).toBe("owner title");
  });

  it("returns an empty state for a session with no slots, no pr, and no file", async () => {
    const dataDir = await newDataDir();
    const owner = baseSession();
    const resolved = resolveWorkspaceState(dataDir, owner);
    expect(resolved.slots).toBeUndefined();
    expect(resolved.pr).toBeUndefined();
  });
});

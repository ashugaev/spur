import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SHARED_MEMORY_SECTION_MARKER,
  getSharedMemory,
  listSharedMemoryKeys,
  removeSharedMemory,
  setSharedMemory,
  withSharedMemoryInstructions,
} from "../../src/shared-memory.js";
import { createTempDir } from "../helpers/common.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newDataDir(): Promise<string> {
  const dir = await createTempDir("spur-shared-memory-");
  tempDirs.push(dir);
  return dir;
}

function hasTmpResidue(dir: string): boolean {
  if (!existsSync(dir)) {
    return false;
  }
  return readdirSync(dir).some((name) => name.includes(".tmp."));
}

describe("shared memory storage", () => {
  it("round-trips a multiline markdown body byte-for-byte for each scope", async () => {
    const dataDir = await newDataDir();
    const body = "# Decision\n\n- use HTTP API\n- multiline body\n";

    const taskEntry = setSharedMemory(dataDir, "task", "desk-1", "decision.api", body);
    const projectEntry = setSharedMemory(dataDir, "project", "api", "gotcha.env", body);
    const globalEntry = setSharedMemory(dataDir, "global", "global", "preference.style", body);

    expect(taskEntry).toEqual({ key: "decision.api", body });
    expect(projectEntry).toEqual({ key: "gotcha.env", body });
    expect(globalEntry).toEqual({ key: "preference.style", body });

    expect(getSharedMemory(dataDir, "task", "desk-1", "decision.api")).toEqual({
      key: "decision.api",
      body,
    });
    expect(getSharedMemory(dataDir, "project", "api", "gotcha.env")).toEqual({
      key: "gotcha.env",
      body,
    });
    expect(getSharedMemory(dataDir, "global", "global", "preference.style")).toEqual({
      key: "preference.style",
      body,
    });
  });

  it("writes each scope to the exact on-disk path", async () => {
    const dataDir = await newDataDir();
    const body = "note";

    setSharedMemory(dataDir, "task", "desk-1", "decision.api", body);
    setSharedMemory(dataDir, "project", "api", "gotcha.env", body);
    setSharedMemory(dataDir, "global", "irrelevant-store-id", "preference.style", body);

    expect(
      readFileSync(join(dataDir, "memory", "task", "desk-1", "decision.api.md"), "utf-8"),
    ).toBe(body);
    expect(readFileSync(join(dataDir, "memory", "project", "api", "gotcha.env.md"), "utf-8")).toBe(
      body,
    );
    expect(readFileSync(join(dataDir, "memory", "global", "preference.style.md"), "utf-8")).toBe(
      body,
    );
    // Global scope never nests under the passed storeId.
    expect(existsSync(join(dataDir, "memory", "global", "irrelevant-store-id"))).toBe(false);
  });

  it("lists keys sorted, strips .md, hides leftover .tmp.* write residue and returns [] for a missing dir", async () => {
    const dataDir = await newDataDir();

    expect(listSharedMemoryKeys(dataDir, "task", "desk-1")).toEqual([]);

    setSharedMemory(dataDir, "task", "desk-1", "zeta", "z");
    setSharedMemory(dataDir, "task", "desk-1", "alpha", "a");
    setSharedMemory(dataDir, "task", "desk-1", "build.tmp.notes", "n");
    // Simulate a crash mid-rename that left the temp write file behind.
    const dir = join(dataDir, "memory", "task", "desk-1");
    writeFileSync(join(dir, "foo.md.tmp.1.2"), "residue");

    expect(listSharedMemoryKeys(dataDir, "task", "desk-1")).toEqual([
      "alpha",
      "build.tmp.notes",
      "zeta",
    ]);
    // The legal key "build.tmp.notes" itself contains ".tmp." so
    // hasTmpResidue(dir) alone would be true even without the planted
    // residue file. Assert the specific planted filename survived instead.
    expect(existsSync(join(dir, "foo.md.tmp.1.2"))).toBe(true);
  });

  it("overwrites a key last-writer-wins", async () => {
    const dataDir = await newDataDir();

    setSharedMemory(dataDir, "project", "api", "decision.api", "old");
    const updated = setSharedMemory(dataDir, "project", "api", "decision.api", "new");

    expect(updated).toEqual({ key: "decision.api", body: "new" });
    expect(getSharedMemory(dataDir, "project", "api", "decision.api")).toEqual({
      key: "decision.api",
      body: "new",
    });
    expect(listSharedMemoryKeys(dataDir, "project", "api")).toEqual(["decision.api"]);
  });

  it("removes a key and reports missing removal without mutating fs", async () => {
    const dataDir = await newDataDir();
    setSharedMemory(dataDir, "task", "desk-1", "decision.api", "body");

    expect(removeSharedMemory(dataDir, "task", "desk-1", "decision.api")).toBe(true);
    expect(getSharedMemory(dataDir, "task", "desk-1", "decision.api")).toBeNull();
    expect(existsSync(join(dataDir, "memory", "task", "desk-1", "decision.api.md"))).toBe(false);

    expect(removeSharedMemory(dataDir, "task", "desk-1", "missing")).toBe(false);
  });

  it("returns null when getting a missing key", async () => {
    const dataDir = await newDataDir();
    expect(getSharedMemory(dataDir, "task", "desk-1", "missing")).toBeNull();
  });

  it("rejects an invalid scope before touching fs", async () => {
    const dataDir = await newDataDir();

    expect(() => listSharedMemoryKeys(dataDir, "bogus", "desk-1")).toThrow(/scope/);
    expect(() => getSharedMemory(dataDir, "bogus", "desk-1", "key")).toThrow(/scope/);
    expect(() => setSharedMemory(dataDir, "bogus", "desk-1", "key", "body")).toThrow(/scope/);
    expect(() => removeSharedMemory(dataDir, "bogus", "desk-1", "key")).toThrow(/scope/);
    expect(existsSync(join(dataDir, "memory"))).toBe(false);
  });

  it("rejects an invalid store id, including traversal attempts, before touching fs", async () => {
    const dataDir = await newDataDir();

    expect(() => setSharedMemory(dataDir, "task", "../escape", "key", "body")).toThrow(/store id/);
    expect(() => setSharedMemory(dataDir, "project", "a/b", "key", "body")).toThrow(/store id/);
    expect(existsSync(join(dataDir, "memory"))).toBe(false);
  });

  it("rejects an invalid key, including traversal attempts, before touching fs", async () => {
    const dataDir = await newDataDir();

    expect(() => setSharedMemory(dataDir, "task", "desk-1", "../escape", "body")).toThrow(/key/);
    expect(() => setSharedMemory(dataDir, "task", "desk-1", "Bad", "body")).toThrow(/key/);
    expect(existsSync(join(dataDir, "memory"))).toBe(false);
  });

  it("leaves no .tmp.* residue after a successful set", async () => {
    const dataDir = await newDataDir();
    setSharedMemory(dataDir, "task", "desk-1", "decision.api", "body");
    expect(hasTmpResidue(join(dataDir, "memory", "task", "desk-1"))).toBe(false);
  });
});

describe("withSharedMemoryInstructions", () => {
  it("appends the shared memory discovery block", () => {
    const prompt = withSharedMemoryInstructions("Ship the feature");
    expect(prompt).toContain("Ship the feature");
    expect(prompt).toContain("Shared memory:");
    expect(prompt).toContain("spur memory set|get|list|rm");
    expect(prompt).toContain("--scope task|project|global");
  });

  it("is idempotent", () => {
    const once = withSharedMemoryInstructions("Ship the feature");
    const twice = withSharedMemoryInstructions(once);
    expect(twice).toBe(once);
  });

  it("still appends the block when the prompt merely quotes the CLI usage string", () => {
    // Regression: the guard used to be the literal usage string
    // "spur memory set|get|list|rm", so a task prompt that happens to quote
    // that syntax (e.g. asking to implement the command, or to edit the
    // memory section of docs/commands.md) made the guard match and silently
    // skipped appending the block.
    const prompt = withSharedMemoryInstructions(
      "implement `spur memory set|get|list|rm ...` in the CLI",
    );

    expect(prompt.split("Shared memory:").length - 1).toBe(1);
    expect(prompt).toContain("On start: `spur memory list --scope task`");
  });

  it("does not append a second block when the prompt already carries the section heading", () => {
    const alreadyWrapped = `Ship the feature${SHARED_MEMORY_SECTION_MARKER}\n- custom notes`;
    const prompt = withSharedMemoryInstructions(alreadyWrapped);

    expect(prompt).toBe(alreadyWrapped);
    expect(prompt.split("Shared memory:").length - 1).toBe(1);
  });
});

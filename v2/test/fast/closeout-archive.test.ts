import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLOSEOUT_ROOTS,
  CLOSEOUT_WALK_MAX_ENTRIES,
  CloseoutCorruptError,
  closeoutDirAt,
  closeoutSettings,
  expireCloseout,
  readCloseoutManifest,
  resolveCloseoutFile,
  writeCloseoutArchive,
} from "../../src/closeout-archive.js";
import type { CloseoutRoot, ProjectConfig } from "../../src/types.js";

let base: string;
let artifacts: string;
let work: string;
let sessionDir: string;

function put(file: string, content: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

function write(
  overrides: {
    include?: string[];
    maxBytes?: number;
    roots?: Partial<Record<CloseoutRoot, string | null>>;
    completedAt?: string;
  } = {},
) {
  return writeCloseoutArchive({
    sessionDir,
    sessionId: "s1",
    project: "p",
    completedAt: overrides.completedAt ?? "2026-01-01T00:00:00.000Z",
    links: [{ label: "board-worker", url: "https://example.com/1" }],
    snapshotVersion: 3,
    headSha: "abc",
    roots: { artifacts, work, workspace: null, ...overrides.roots },
    include: overrides.include ?? ["work:**", "artifacts:**"],
    maxBytes: overrides.maxBytes ?? 1000,
  });
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "closeout-"));
  artifacts = join(base, "artifacts");
  work = join(artifacts, ".spur-work");
  sessionDir = join(base, "sessions", "s1");
  mkdirSync(work, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const paths = (m: Awaited<ReturnType<typeof write>>) =>
  m.files.map((f) => `${f.root}/${f.path}`).sort();

describe("closeout archive", () => {
  it("applies defaults", () => {
    expect(closeoutSettings(undefined)).toEqual({
      enabled: true,
      include: ["work:**", "artifacts:**"],
      maxBytes: 52428800,
      retentionDays: null,
    });
    const project = {
      closeout: { enabled: false, maxBytes: 5, retentionDays: 2 },
    } as ProjectConfig;
    expect(closeoutSettings(project)).toMatchObject({
      enabled: false,
      maxBytes: 5,
      retentionDays: 2,
    });
    expect(CLOSEOUT_ROOTS).toEqual(["artifacts", "work", "workspace"]);
    expect(closeoutDirAt("/d", { id: "i", project: "p" }, "archived")).toBe(
      "/d/sessions-archive/p/i/closeout",
    );
  });

  it("copies work and artifacts, skips metadata and dot dirs", async () => {
    put(join(work, "notes.md"), "hello");
    put(join(artifacts, "report.txt"), "r");
    put(join(artifacts, "sub", "deep.txt"), "d");
    put(join(artifacts, ".spur-artifacts.json"), "{}");
    put(join(artifacts, ".hidden", "x.txt"), "x");
    const manifest = await write();
    expect(paths(manifest)).toEqual([
      "artifacts/report.txt",
      "artifacts/sub/deep.txt",
      "work/notes.md",
    ]);
    expect(manifest.files.find((f) => f.path === "notes.md")).toMatchObject({
      bytes: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    expect(manifest.missingRoots).toEqual([]);
    expect(readFileSync(join(sessionDir, "closeout", "files", "work", "notes.md"), "utf8")).toBe(
      "hello",
    );
    expect(readCloseoutManifest(join(sessionDir, "closeout"), "s1")).toEqual(manifest);
  });

  it("copies own agent-history captures only on an explicit pattern", async () => {
    put(join(artifacts, "agent-history-s1-1-a-to-b.jsonl"), "own");
    put(join(artifacts, "agent-history-s2-1-a-to-b.jsonl"), "other");
    put(join(artifacts, "keep.txt"), "k");
    const plain = await write();
    expect(paths(plain)).toEqual(["artifacts/keep.txt"]);
    const withHistory = await write({ include: ["artifacts:**", "artifacts:agent-history-*"] });
    expect(paths(withHistory)).toEqual([
      "artifacts/agent-history-s1-1-a-to-b.jsonl",
      "artifacts/keep.txt",
    ]);
  });

  it("lists over-cap files as skipped and still copies later smaller ones", async () => {
    put(join(artifacts, "a-big.bin"), "x".repeat(50));
    put(join(artifacts, "b-small.txt"), "ok");
    const manifest = await write({ maxBytes: 10 });
    expect(manifest.skipped).toEqual([
      { root: "artifacts", path: "a-big.bin", bytes: 50, reason: "max_bytes" },
    ]);
    expect(paths(manifest)).toEqual(["artifacts/b-small.txt"]);
  });

  it("never follows symlinks", async () => {
    const outside = join(base, "outside");
    put(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(artifacts, "link.txt"));
    symlinkSync(outside, join(artifacts, "linkdir"));
    put(join(artifacts, "real.txt"), "r");
    const manifest = await write();
    expect(paths(manifest)).toEqual(["artifacts/real.txt"]);
    expect(manifest.skipped).toEqual([]);
  });

  it("lists only named roots as missing", async () => {
    expect((await write()).missingRoots).toEqual([]);
    expect((await write({ include: ["workspace:docs/**"] })).missingRoots).toEqual(["workspace"]);
    await rm(work, { recursive: true });
    expect((await write({ include: ["work:**"] })).missingRoots).toEqual(["work"]);
  });

  it("copies workspace files by pattern", async () => {
    const ws = join(base, "ws");
    put(join(ws, "docs", "a.md"), "a");
    put(join(ws, "src", "b.ts"), "b");
    const manifest = await write({ include: ["workspace:docs/**"], roots: { workspace: ws } });
    expect(paths(manifest)).toEqual(["workspace/docs/a.md"]);
  });

  it("names dot files only through a pattern that names them", async () => {
    put(join(artifacts, ".github", "x.yml"), "x");
    const manifest = await write({ include: ["artifacts:.github/**"] });
    expect(paths(manifest)).toEqual(["artifacts/.github/x.yml"]);
  });

  it("records an error and keeps partial files when the walk budget is exhausted", async () => {
    for (let i = 0; i < CLOSEOUT_WALK_MAX_ENTRIES + 1; i += 1)
      put(join(artifacts, `f${i}.txt`), "");
    const manifest = await write();
    expect(manifest.error).toContain(String(CLOSEOUT_WALK_MAX_ENTRIES));
    expect(existsSync(join(sessionDir, "closeout", "closeout.json"))).toBe(true);
    expect(readCloseoutManifest(join(sessionDir, "closeout"), "s1")?.error).toBe(manifest.error);
  });

  it("removes stale temp dirs and replaces a previous archive", async () => {
    mkdirSync(join(sessionDir, "closeout.tmp-stale", "files"), { recursive: true });
    writeFileSync(join(sessionDir, "closeout.tmp-stale", "files", "x"), "x");
    put(join(artifacts, "one.txt"), "1");
    await write();
    expect(existsSync(join(sessionDir, "closeout.tmp-stale"))).toBe(false);
    await rm(join(artifacts, "one.txt"));
    put(join(artifacts, "two.txt"), "2");
    const second = await write();
    expect(paths(second)).toEqual(["artifacts/two.txt"]);
    expect(existsSync(join(sessionDir, "closeout", "files", "artifacts", "one.txt"))).toBe(false);
  });

  it("throws CloseoutCorruptError for a corrupt manifest", () => {
    const dir = join(sessionDir, "closeout");
    put(join(dir, "closeout.json"), "{nope");
    expect(() => readCloseoutManifest(dir, "s1")).toThrow(CloseoutCorruptError);
    put(join(dir, "closeout.json"), '{"sessionId":"other"}');
    expect(() => readCloseoutManifest(dir, "s1")).toThrow(CloseoutCorruptError);
    expect(readCloseoutManifest(join(base, "none"), "s1")).toBeNull();
  });

  it("resolves files under closeout/files only", async () => {
    put(join(artifacts, "a.txt"), "a");
    await write();
    const dir = join(sessionDir, "closeout");
    expect(resolveCloseoutFile(dir, "artifacts/a.txt")).toMatchObject({ size: 1, name: "a.txt" });
    expect(resolveCloseoutFile(dir, "artifacts/../closeout.json")).toBeNull();
    expect(resolveCloseoutFile(dir, "bogus/a.txt")).toBeNull();
    expect(resolveCloseoutFile(dir, "artifacts")).toBeNull();
    expect(resolveCloseoutFile(dir, "artifacts/missing")).toBeNull();
    symlinkSync(join(dir, "closeout.json"), join(dir, "files", "artifacts", "esc"));
    expect(resolveCloseoutFile(dir, "artifacts/esc")).toBeNull();
  });

  it("expires due archives once and keeps the manifest", async () => {
    put(join(artifacts, "a.txt"), "a");
    await write({ completedAt: "2026-01-01T00:00:00.000Z" });
    const dir = join(sessionDir, "closeout");
    const day = 86_400_000;
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    expect(expireCloseout(dir, "s1", 5, start + day)).toBe(false);
    expect(existsSync(join(dir, "files"))).toBe(true);
    expect(expireCloseout(dir, "s1", 5, start + 6 * day)).toBe(true);
    expect(existsSync(join(dir, "files"))).toBe(false);
    expect(readCloseoutManifest(dir, "s1")?.expiredAt).toBeTruthy();
    expect(expireCloseout(dir, "s1", 5, start + 7 * day)).toBe(false);
    expect(resolveCloseoutFile(dir, "artifacts/a.txt")).toBeNull();
  });
});

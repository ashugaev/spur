import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

describe("published interface contracts", () => {
  it("documents closeout ownership in command docs", async () => {
    const commands = await readRepoFile("docs/commands.md");

    expect(commands).toContain("marks the assigned closeout owner for a writable worktree");
    expect(commands).toContain("transferred handoff ownership on a reused workspace");
    expect(commands).toContain("`0` marks non-owners, including read-only and shared-workspace");
    expect(commands).toContain("missing variable preserves standalone hook enforcement");
  });
});

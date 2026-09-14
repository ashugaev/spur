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

    expect(commands).toMatch(/SPUR_CLOSEOUT_OWNER=1[^\n]*`0`/);
  });
});

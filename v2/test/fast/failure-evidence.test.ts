import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDir } from "../helpers/common.js";
import { copyFailureEvidence } from "../helpers/failure-evidence.js";

describe("copyFailureEvidence", () => {
  it("copies session state and config but never credentials or symlinks", async () => {
    const root = await createTempDir("spur-evidence-src-");
    const out = join(await createTempDir("spur-evidence-out-"), "evidence");
    const sessionDir = join(root, "data", "sessions", "s1");
    await mkdir(join(sessionDir, "codex-home"), { recursive: true });
    await writeFile(join(sessionDir, "session.json"), "{}");
    await writeFile(join(sessionDir, "events.jsonl"), "e\n");
    await writeFile(join(root, "spur.yaml"), "port: 1\n");
    await writeFile(join(sessionDir, "auth.json"), "secret");
    await writeFile(join(sessionDir, ".credentials.json"), "secret");
    await writeFile(join(sessionDir, "token.env"), "secret");
    await writeFile(join(sessionDir, "key.pem"), "secret");
    await writeFile(join(root, "real-secret"), "secret");
    const toolsDir = join(root, "data", "session-tools", "s1");
    await mkdir(join(toolsDir, "codex-home"), { recursive: true });
    await mkdir(join(toolsDir, "claude-home"), { recursive: true });
    await writeFile(join(toolsDir, "codex-home", "config.toml"), "x");
    await writeFile(join(toolsDir, "claude-home", ".claude.json"), "x");
    await symlink(join(root, "real-secret"), join(sessionDir, "codex-home", "link"));

    await copyFailureEvidence(root, out);

    const copied = join(out, "data", "sessions", "s1");
    expect(await readFile(join(copied, "session.json"), "utf8")).toBe("{}");
    expect(existsSync(join(copied, "events.jsonl"))).toBe(true);
    expect(existsSync(join(out, "spur.yaml"))).toBe(true);
    for (const name of ["auth.json", ".credentials.json", "token.env", "key.pem"]) {
      expect(existsSync(join(copied, name))).toBe(false);
    }
    expect(existsSync(join(copied, "codex-home", "link"))).toBe(false);
    expect(existsSync(join(out, "data", "session-tools"))).toBe(false);
  });
});

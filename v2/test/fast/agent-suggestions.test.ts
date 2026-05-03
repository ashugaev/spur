import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectSuggestions, loadSessionSuggestions } from "../../src/agent-suggestions.js";

describe("agent suggestions", () => {
  it("loads claude built-ins plus project-local commands, skills, and agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-claude-suggestions-"));
    await mkdir(join(root, ".claude", "commands"), { recursive: true });
    await mkdir(join(root, ".claude", "skills", "manager"), { recursive: true });
    await mkdir(join(root, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(root, ".claude", "commands", "triage.md"),
      ["---", "description: Triage the issue", "---", "Triage it."].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "skills", "manager", "SKILL.md"),
      ["---", "name: manager", "description: Run the manager workflow", "---", "content"].join(
        "\n",
      ),
      "utf8",
    );
    await writeFile(
      join(root, ".claude", "agents", "reviewer.md"),
      ["---", "name: reviewer", "description: Review the diff", "---", "content"].join("\n"),
      "utf8",
    );

    const result = await loadProjectSuggestions("claude", root);

    expect(result.agent).toBe("claude");
    expect(result.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "/compact", source: "built-in" }),
        expect.objectContaining({ label: "/triage", source: "project" }),
      ]),
    );
    expect(result.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "manager", insertText: "/manager", source: "project" }),
      ]),
    );
    expect(result.agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "reviewer", source: "project" })]),
    );
  });

  it("loads codex built-ins plus project skills and session-local prompts and agents", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "spur-codex-project-"));
    const codexHome = await mkdtemp(join(tmpdir(), "spur-codex-home-"));
    await mkdir(join(projectRoot, ".agents", "skills", "ultracareful"), { recursive: true });
    await mkdir(join(codexHome, "prompts"), { recursive: true });
    await mkdir(join(codexHome, "agents"), { recursive: true });
    await writeFile(
      join(projectRoot, ".agents", "skills", "ultracareful", "SKILL.md"),
      ["---", "name: ultracareful", "description: Proceed carefully", "---", "content"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(codexHome, "prompts", "draftpr.md"),
      ["---", "description: Draft a PR", 'argument-hint: TITLE="<title>"', "---", "content"].join(
        "\n",
      ),
      "utf8",
    );
    await writeFile(
      join(codexHome, "agents", "worker.toml"),
      ['name = "worker"', 'description = "Implementation worker"'].join("\n"),
      "utf8",
    );

    const result = await loadSessionSuggestions({
      agent: "codex",
      worktreePath: projectRoot,
      codexHomePath: codexHome,
    });

    expect(result.agent).toBe("codex");
    expect(result.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "/permissions", source: "built-in" }),
        expect.objectContaining({ label: "/prompts:draftpr", source: "session" }),
      ]),
    );
    expect(result.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "ultracareful",
          insertText: "$ultracareful",
          source: "project",
        }),
      ]),
    );
    expect(result.agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "worker", source: "session" })]),
    );
  });
});

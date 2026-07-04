import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { listAgentModels, parseCursorModelsOutput } from "../../src/agents/models.js";

beforeEach(() => {
  execFileMock.mockReset();
});

afterEach(() => {
  delete process.env["SPUR_CURSOR_BIN"];
});

describe("listAgentModels claude", () => {
  it("returns the curated static list", async () => {
    const models = await listAgentModels("claude");
    expect(models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku", "fable"]);
    expect(models.find((m) => m.id === "sonnet")?.isDefault).toBe(true);
  });
});

describe("listAgentModels codex", () => {
  it("parses models_cache.json with visibility filter and mapping", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spur-codex-models-"));
    await writeFile(
      join(dir, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
          { slug: "gpt-hidden", display_name: "Hidden", visibility: "hidden" },
          { slug: "no-name", visibility: "list" },
        ],
      }),
    );
    const models = await listAgentModels("codex", { codexHomePath: dir });
    expect(models).toEqual([
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "no-name", label: "no-name" },
    ]);
  });

  it("falls back to a static list when the cache is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spur-codex-nomodels-"));
    const models = await listAgentModels("codex", { codexHomePath: dir });
    expect(models).toEqual([{ id: "gpt-5.5", label: "GPT-5.5", isDefault: true }]);
  });
});

describe("parseCursorModelsOutput", () => {
  it("collapses -fast pairs onto the base and transfers the default", () => {
    const stdout = [
      "Available models",
      "",
      "auto - Auto",
      "composer-2.5 - Composer 2.5",
      "composer-2.5-fast - Composer 2.5 Fast (default)",
      "claude-opus-4-8-high - Opus 4.8 1M",
    ].join("\n");
    const models = parseCursorModelsOutput(stdout);
    expect(models).toEqual([
      { id: "auto", label: "Auto" },
      { id: "composer-2.5", label: "Composer 2.5", isDefault: true },
      { id: "claude-opus-4-8-high", label: "Opus 4.8 1M" },
    ]);
  });

  it("keeps a lone -fast entry with no base sibling", () => {
    const stdout = ["auto - Auto", "sonic-fast - Sonic Fast"].join("\n");
    const models = parseCursorModelsOutput(stdout);
    expect(models).toEqual([
      { id: "auto", label: "Auto" },
      { id: "sonic-fast", label: "Sonic Fast" },
    ]);
  });

  it("strips a trailing (current) label like (default)", () => {
    const stdout = ["composer-2.5 - Composer 2.5 (current)"].join("\n");
    const models = parseCursorModelsOutput(stdout);
    expect(models).toEqual([{ id: "composer-2.5", label: "Composer 2.5", isDefault: true }]);
  });
});

describe("listAgentModels cursor", () => {
  it("returns a fallback list when the exec fails", async () => {
    process.env["SPUR_CURSOR_BIN"] = "cursor-agent-model-test-missing";
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error("ENOENT"));
      },
    );
    const models = await listAgentModels("cursor");
    expect(models).toEqual([{ id: "auto", label: "Auto", isDefault: true }]);
  });
});

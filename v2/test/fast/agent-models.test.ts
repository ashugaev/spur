import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));
const originalPath = process.env["PATH"];

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  listAgentModels,
  parseCursorModelsOutput,
  pickCursorNormalModelId,
  resolveCursorLaunchModel,
  parseOpenCodeModelsOutput,
  validateOpenCodeModel,
} from "../../src/agents/models.js";

beforeEach(() => {
  execFileMock.mockReset();
});

afterEach(() => {
  delete process.env["SPUR_CURSOR_BIN"];
  delete process.env["SPUR_OPENCODE_BIN"];
  process.env["PATH"] = originalPath;
});

describe("listAgentModels claude", () => {
  it("returns the curated static list", async () => {
    const models = await listAgentModels("claude");
    expect(models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku", "fable"]);
    expect(models.find((m) => m.id === "opus")?.isDefault).toBe(true);
    expect(models.find((m) => m.id === "sonnet")?.isDefault).toBeUndefined();
  });
});

describe("listAgentModels codex", () => {
  it("parses models_cache.json with visibility filter and mapping", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spur-codex-models-"));
    await writeFile(
      join(dir, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "gpt-current", display_name: "Current GPT", visibility: "list" },
          { slug: "gpt-hidden", display_name: "Hidden", visibility: "hidden" },
          { slug: "no-name", visibility: "list" },
        ],
      }),
    );
    const models = await listAgentModels("codex", { codexHomePath: dir });
    expect(models).toEqual([
      { id: "gpt-current", label: "Current GPT" },
      { id: "no-name", label: "no-name" },
    ]);
  });

  it("returns no rows when the cache is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spur-codex-nomodels-"));
    const models = await listAgentModels("codex", { codexHomePath: dir });
    expect(models).toEqual([]);
  });
});

describe("parseCursorModelsOutput", () => {
  it("parses id/label rows and flags the default", () => {
    const stdout = [
      "Available models",
      "",
      "auto - Auto",
      "composer-2.5 - Composer 2.5 (current)",
      "composer-2.5-fast - Composer 2.5 Fast (default)",
      "claude-opus-4-8-high - Opus 4.8 1M",
    ].join("\n");
    const models = parseCursorModelsOutput(stdout);
    expect(models).toEqual([
      { id: "auto", label: "Auto" },
      { id: "composer-2.5", label: "Composer 2.5", isCurrent: true },
      { id: "composer-2.5-fast", label: "Composer 2.5 Fast", isDefault: true },
      { id: "claude-opus-4-8-high", label: "Opus 4.8 1M" },
    ]);
  });
});

describe("listAgentModels cursor", () => {
  it("bounds the `cursor models` shell-out with a timeout, so a hung CLI can't stall the request indefinitely", async () => {
    process.env["SPUR_CURSOR_BIN"] = "cursor-agent-model-test-timeout";
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: { timeout?: number },
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error("ETIMEDOUT"));
      },
    );
    const models = await listAgentModels("cursor");
    // Same graceful degrade as any other exec failure (e.g. cursor missing).
    expect(models).toEqual([{ id: "auto", label: "Auto", isDefault: true }]);
    // Asserted after the call, not inside the mock implementation: a thrown
    // expectation there would be swallowed by listCursorModels' catch-all
    // and silently pass as just another "exec failed" case.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, , opts] = execFileMock.mock.calls[0] as [string, string[], { timeout?: number }];
    expect(opts.timeout).toBe(5_000);
  });

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

  it("dedupes concurrent calls onto a single exec instead of running `cursor models` twice", async () => {
    process.env["SPUR_CURSOR_BIN"] = "cursor-agent-model-test-concurrent";
    let resolveExec!: (result: { stdout: string }) => void;
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string }) => void,
      ) => {
        resolveExec = (result) => cb(null, result);
      },
    );
    const first = listAgentModels("cursor");
    const second = listAgentModels("cursor");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    resolveExec({ stdout: ["auto - Auto"].join("\n") });
    const [firstModels, secondModels] = await Promise.all([first, second]);
    expect(firstModels).toEqual([{ id: "auto", label: "Auto", isDefault: true }]);
    expect(secondModels).toEqual(firstModels);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejected in-flight entry so a later call retries instead of being poisoned", async () => {
    process.env["SPUR_CURSOR_BIN"] = "cursor-agent-model-test-poison";
    execFileMock.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error("ENOENT"));
      },
    );
    const failed = await listAgentModels("cursor");
    expect(failed).toEqual([{ id: "auto", label: "Auto", isDefault: true }]);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    execFileMock.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string }) => void,
      ) => {
        cb(null, { stdout: "composer-2.5 - Composer 2.5 (current)" });
      },
    );
    const succeeded = await listAgentModels("cursor");
    expect(succeeded).toEqual([{ id: "composer-2.5", label: "Composer 2.5", isCurrent: true }]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("marks auto as Spur's Cursor default over CLI fast default", async () => {
    process.env["SPUR_CURSOR_BIN"] = "cursor-agent-model-test";
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string }) => void,
      ) => {
        cb(null, {
          stdout: [
            "Available models",
            "auto - Auto",
            "composer-2.5 - Composer 2.5 (current)",
            "composer-2.5-fast - Composer 2.5 Fast (default)",
          ].join("\n"),
        });
      },
    );
    const models = await listAgentModels("cursor");
    expect(models).toEqual([
      { id: "auto", label: "Auto", isDefault: true },
      { id: "composer-2.5", label: "Composer 2.5", isCurrent: true },
      { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
    ]);
  });
});

describe("pickCursorNormalModelId", () => {
  it("prefers the current non-fast model", () => {
    expect(
      pickCursorNormalModelId([
        { id: "auto", label: "Auto" },
        { id: "composer-2.5", label: "Composer 2.5", isCurrent: true },
        { id: "composer-2.5-fast", label: "Composer 2.5 Fast", isDefault: true },
      ]),
    ).toBe("composer-2.5");
  });
});

describe("resolveCursorLaunchModel", () => {
  it("resolves auto to the normal non-fast model", async () => {
    process.env["SPUR_CURSOR_BIN"] = "cursor-agent-model-test";
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string }) => void,
      ) => {
        cb(null, {
          stdout: [
            "auto - Auto",
            "composer-2.5 - Composer 2.5 (current)",
            "composer-2.5-fast - Composer 2.5 Fast (default)",
          ].join("\n"),
        });
      },
    );
    await expect(resolveCursorLaunchModel("auto")).resolves.toBe("composer-2.5");
  });

  it("keeps an explicit fast model", async () => {
    await expect(resolveCursorLaunchModel("composer-2.5-fast")).resolves.toBe("composer-2.5-fast");
  });
});

describe("parseOpenCodeModelsOutput", () => {
  it("parses the pinned CLI's newline-delimited provider/model output", () => {
    const stdout = [
      "opencode/big-pickle",
      "digitalocean/fal-ai/flux/schnell",
      "anthropic/claude-sonnet-4",
      "",
    ].join("\n");
    expect(parseOpenCodeModelsOutput(stdout)).toEqual([
      { id: "opencode/big-pickle", label: "opencode/big-pickle" },
      {
        id: "digitalocean/fal-ai/flux/schnell",
        label: "digitalocean/fal-ai/flux/schnell",
      },
      { id: "anthropic/claude-sonnet-4", label: "anthropic/claude-sonnet-4" },
    ]);
  });

  it("reports a missing executable while validating an explicit model", async () => {
    process.env["SPUR_OPENCODE_BIN"] = "opencode-model-test-missing";
    process.env["PATH"] = "";
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error("ENOENT"));
      },
    );

    await expect(validateOpenCodeModel("openai/gpt-5")).rejects.toThrow(
      "opencode executable not found: opencode-model-test-missing; install it on PATH or set SPUR_OPENCODE_BIN to an executable path",
    );
  });

  it("keeps the validation-specific error when an available executable cannot list models", async () => {
    process.env["SPUR_OPENCODE_BIN"] = process.execPath;
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error("models failed"));
      },
    );

    await expect(validateOpenCodeModel("openai/gpt-5")).rejects.toThrow(
      'Cannot validate OpenCode model "openai/gpt-5": model list unavailable',
    );
  });

  it("reports the missing executable instead of returning an empty catalog", async () => {
    process.env["SPUR_OPENCODE_BIN"] = "opencode-model-test-missing";
    process.env["PATH"] = "";
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error("ENOENT"));
      },
    );

    await expect(listAgentModels("opencode")).rejects.toThrow(
      "opencode executable not found: opencode-model-test-missing; install it on PATH or set SPUR_OPENCODE_BIN to an executable path",
    );
  });

  it("rejects an explicit model when discovery returns no models", async () => {
    process.env["SPUR_OPENCODE_BIN"] = "opencode-model-test-empty";
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string }) => void,
      ) => cb(null, { stdout: "" }),
    );

    await expect(validateOpenCodeModel("openai/gpt-5")).rejects.toThrow(
      'Cannot validate OpenCode model "openai/gpt-5": model list is empty',
    );
  });

  it("rejects an explicit model absent from the discovered catalog", async () => {
    process.env["SPUR_OPENCODE_BIN"] = "opencode-model-test";
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string }) => void,
      ) => cb(null, { stdout: "openai/gpt-5\n" }),
    );

    await expect(validateOpenCodeModel("openai/missing")).rejects.toThrow(
      'OpenCode model "openai/missing" is not available',
    );
  });

  it("accepts an explicit model present in the discovered catalog", async () => {
    process.env["SPUR_OPENCODE_BIN"] = "opencode-model-test";
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string }) => void,
      ) => cb(null, { stdout: "openai/gpt-5\n" }),
    );

    await expect(validateOpenCodeModel("openai/gpt-5")).resolves.toBe("openai/gpt-5");
  });
});

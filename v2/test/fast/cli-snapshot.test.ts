import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const getJsonMock = vi.fn();
const postJsonMock = vi.fn();
const writeStdoutMock = vi.fn();
const stdinMock = vi.hoisted(() => ({ text: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      path === 0
        ? stdinMock.text
        : (actual.readFileSync as (...args: unknown[]) => unknown)(
            path,
            ...rest,
          )) as typeof actual.readFileSync,
  };
});

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: getJsonMock,
  listProjects: vi.fn(),
  postJson: postJsonMock,
  postPreflight: vi.fn(),
  restartDaemonIfRunning: vi.fn(),
  stopDaemonIfRunning: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  defaultVoiceModelPath: vi.fn(),
  createProjectConfigScaffold: vi.fn(),
  ensureInstanceConfig: vi.fn(() => ({ configPath: "/tmp/spur.yaml", initialized: false })),
  findProjectConfigPath: vi.fn(),
  loadConfig: vi.fn(() => ({ tmux: { socketName: "spur-test" } })),
  loadProjectConfig: vi.fn(),
  writeProjectConfigScaffold: vi.fn(),
}));

vi.mock("../../src/io.js", () => ({
  writeStderr: vi.fn(),
  writeStdout: writeStdoutMock,
}));

vi.mock("../../src/runtime-tmux.js", async (importOriginal) => ({
  TmuxProbeUnknownError: (await importOriginal<typeof RuntimeTmuxModule>()).TmuxProbeUnknownError,
  setTmuxSocketName: vi.fn(),
  sidecarTmuxSession: vi.fn((id: string, name: string) => `${id}--${name}`),
  withTmuxSocketArgs: vi.fn((args: string[]) => args),
}));

async function run(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

const meta = {
  version: 2,
  at: "2026-11-01T10:00:00.000Z",
  sessionId: "api-1",
  project: "api",
  agent: "claude",
  model: null,
  branch: "feature/x",
  headSha: "0123456789abcdef",
  dirty: false,
  todoRevision: "r",
  links: [],
  trigger: "manual",
  final: false,
};

describe("snapshot CLI", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset();
    postJsonMock.mockReset();
    writeStdoutMock.mockReset();
    stdinMock.text = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the file content and --final", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "spur-cli-snap-")), "s.md");
    writeFileSync(file, "# Now\nfile body\n");
    postJsonMock.mockResolvedValue(meta);

    await run(["snapshot", "write", "api-1", "--file", file, "--json"]);
    expect(postJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/snapshots",
      { content: "# Now\nfile body\n" },
      "/tmp/spur.yaml",
    );

    await run(["snapshot", "write", "api-1", "--file", file, "--final", "--json"]);
    expect(postJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/snapshots",
      { content: "# Now\nfile body\n", final: true },
      "/tmp/spur.yaml",
    );
  });

  it("reads stdin for --file -", async () => {
    stdinMock.text = "# From stdin\n";
    postJsonMock.mockResolvedValue({ ...meta, final: true });

    await run(["snapshot", "write", "api-1", "--file", "-", "--final"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/snapshots",
      { content: "# From stdin\n", final: true },
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock.mock.calls.flat().join("\n")).toContain("snapshot 2 for api-1 (final)");
  });

  it("shows the latest content by default and a numbered version on request", async () => {
    getJsonMock.mockResolvedValue({ ...meta, content: "# Body" });

    await run(["snapshot", "show", "api-1"]);
    expect(getJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/snapshots/latest",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenLastCalledWith("# Body");

    await run(["snapshot", "show", "api-1", "2", "--json"]);
    expect(getJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/snapshots/2",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenLastCalledWith(
      JSON.stringify({ ...meta, content: "# Body" }, null, 2),
    );
    await expect(run(["snapshot", "show", "api-1", "0"])).rejects.toThrow(
      "version must be a positive integer",
    );
  });

  it("lists one row per version", async () => {
    getJsonMock.mockResolvedValue([meta]);

    await run(["snapshot", "list", "api-1"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/snapshots",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenLastCalledWith(
      "2\t2026-11-01T10:00:00.000Z\tmanual\tfeature/x\t01234567",
    );
  });
});

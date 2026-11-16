import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const getJsonMock = vi.fn();
const getBytesMock = vi.fn();
const writeStdoutMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: getJsonMock,
  getBytes: getBytesMock,
  listProjects: vi.fn(),
  postJson: vi.fn(),
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

const manifest = {
  sessionId: "api-1",
  project: "api",
  completedAt: "2026-11-02T00:00:00.000Z",
  links: [],
  snapshotVersion: 4,
  headSha: "abc123",
  files: [{ root: "work", path: "notes.md", bytes: 7, sha256: "x" }],
  skipped: [{ root: "artifacts", path: "big.bin", bytes: 999, reason: "max_bytes" }],
  missingRoots: [],
  error: "Walk stopped",
};

describe("closeout CLI", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset();
    getBytesMock.mockReset();
    writeStdoutMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("show renders the manifest and --json prints it", async () => {
    getJsonMock.mockResolvedValue(manifest);
    await run(["closeout", "show", "api-1"]);
    expect(getJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/closeout",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenLastCalledWith(
      [
        "completed 2026-11-02T00:00:00.000Z snapshot 4 head abc123",
        "error Walk stopped",
        "work/notes.md\t7",
        "skipped artifacts/big.bin\t999\tmax_bytes",
      ].join("\n"),
    );
    await run(["closeout", "show", "api-1", "--json"]);
    expect(writeStdoutMock).toHaveBeenLastCalledWith(JSON.stringify(manifest, null, 2));
  });

  it("get encodes segments and writes --out or stdout", async () => {
    getBytesMock.mockResolvedValue(Buffer.from("hello"));
    const out = join(mkdtempSync(join(tmpdir(), "spur-cli-closeout-")), "f.txt");
    await run(["closeout", "get", "api-1", "work/dir name/a b.txt", "--out", out]);
    expect(getBytesMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/closeout/files/work/dir%20name/a%20b.txt",
      "/tmp/spur.yaml",
    );
    expect(readFileSync(out, "utf8")).toBe("hello");

    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await run(["closeout", "get", "api-1", "work/a.txt"]);
    expect(write).toHaveBeenCalledWith(Buffer.from("hello"));
  });

  it("list builds repeated link queries and requires --link", async () => {
    getJsonMock.mockResolvedValue([{ sessionId: "api-1", status: "completed", manifest }]);
    await run(["closeout", "list", "--link", "board-worker=https://example.com/1", "--link", "pr"]);
    expect(getJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/closeouts?link=board-worker%3Dhttps%3A%2F%2Fexample.com%2F1&link=pr",
      "/tmp/spur.yaml",
    );
    expect(String(writeStdoutMock.mock.calls.at(-1)?.[0])).toContain("## api-1 (completed)");
    await expect(run(["closeout", "list"])).rejects.toThrow("closeout list requires --link");
  });
});

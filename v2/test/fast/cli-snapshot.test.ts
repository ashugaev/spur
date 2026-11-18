import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as NodeFs from "node:fs";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const getJsonMock = vi.fn();
const postJsonMock = vi.fn();
const writeStdoutMock = vi.fn();
const writeStderrMock = vi.fn();
const stdinMock = vi.hoisted(() => ({ text: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
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
  writeStderr: writeStderrMock,
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

const freshness = {
  ageSeconds: 90,
  activitySince: "2026-11-01T10:05:00.000Z",
  commitsSince: 2,
  stale: true,
};

describe("snapshot CLI", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset();
    postJsonMock.mockReset();
    writeStdoutMock.mockReset();
    writeStderrMock.mockReset();
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

  it("shows stored content on stdout and freshness on stderr", async () => {
    getJsonMock.mockResolvedValue({ ...meta, content: "# Body", freshness });

    await run(["snapshot", "show", "api-1"]);
    expect(getJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/snapshots/latest",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock.mock.calls).toEqual([["# Body"]]);
    expect(writeStderrMock.mock.calls).toEqual([
      ["v2 2026-11-01T10:00:00.000Z age 90s stale yes commits 2 activity 2026-11-01T10:05:00.000Z"],
    ]);
  });

  it("prints unknown counts and the done list", async () => {
    getJsonMock.mockResolvedValue({
      ...meta,
      content: "# Body",
      freshness: { ...freshness, activitySince: null, commitsSince: null, stale: false },
      done: [{ text: "Ship it" }, { text: "Test it" }],
    });

    await run(["snapshot", "show", "api-1", "2", "--include-done"]);

    expect(getJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/snapshots/2?includeDone=1",
      "/tmp/spur.yaml",
    );
    expect(writeStderrMock.mock.calls).toEqual([
      [
        "v2 2026-11-01T10:00:00.000Z age 90s stale no commits ? activity none\ndone: Ship it\ndone: Test it",
      ],
    ]);
    expect(writeStdoutMock).toHaveBeenLastCalledWith("# Body");
  });

  it("prints the full read as JSON and rejects a bad version", async () => {
    getJsonMock.mockResolvedValue({ ...meta, content: "# Body", freshness });

    await run(["snapshot", "show", "api-1", "2", "--json"]);

    expect(writeStdoutMock).toHaveBeenLastCalledWith(
      JSON.stringify({ ...meta, content: "# Body", freshness }, null, 2),
    );
    await expect(run(["snapshot", "show", "api-1", "0"])).rejects.toThrow(
      "version must be a positive integer",
    );
  });

  it("lists newest first with one row per version", async () => {
    getJsonMock.mockResolvedValue([meta]);

    await run(["snapshot", "list", "api-1"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/snapshots?order=desc",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenLastCalledWith(
      "2\t2026-11-01T10:00:00.000Z\tmanual\tfeature/x\t01234567",
    );
  });

  it("forwards --limit and --before to the list query", async () => {
    getJsonMock.mockResolvedValue([]);

    await run(["snapshot", "list", "api-1", "--limit", "5", "--before", "9"]);

    expect(getJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/snapshots?order=desc&limit=5&before=9",
      "/tmp/spur.yaml",
    );
  });

  it("finds the latest snapshot of each session by link", async () => {
    getJsonMock.mockResolvedValue([
      {
        sessionId: "api-1",
        status: "completed",
        state: null,
        snapshot: { ...meta, content: "# Body", freshness, done: [{ text: "Ship it" }] },
      },
      {
        sessionId: "api-2",
        status: "running",
        state: "working",
        snapshot: { ...meta, content: "# Two", freshness, done: null },
      },
    ]);

    await run([
      "snapshot",
      "latest",
      "--link",
      "pr=https://example.test/pr/1",
      "--link",
      "tracker",
      "--include-done",
    ]);

    expect(getJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/snapshots/latest?link=pr%3Dhttps%3A%2F%2Fexample.test%2Fpr%2F1&link=tracker&includeDone=1",
      "/tmp/spur.yaml",
    );
    const header =
      "v2 2026-11-01T10:00:00.000Z age 90s stale yes commits 2 activity 2026-11-01T10:05:00.000Z";
    expect(writeStdoutMock).toHaveBeenLastCalledWith(
      [
        `## api-1 (completed, -)\n${header}\ndone: Ship it\n\n# Body`,
        `## api-2 (running, working)\n${header}\ndone: unreadable ledger\n\n# Two`,
      ].join("\n"),
    );
  });

  it("prints the entries as JSON and requires --link", async () => {
    getJsonMock.mockResolvedValue([]);

    await run(["snapshot", "latest", "--link", "pr", "--json"]);
    expect(writeStdoutMock).toHaveBeenLastCalledWith("[]");
    expect(getJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/snapshots/latest?link=pr",
      "/tmp/spur.yaml",
    );

    getJsonMock.mockClear();
    await expect(run(["snapshot", "latest"])).rejects.toThrow("snapshot latest requires --link");
    expect(getJsonMock).not.toHaveBeenCalled();
  });
});

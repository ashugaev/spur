import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getJsonMock = vi.fn();
const postJsonMock = vi.fn();
const writeStdoutMock = vi.fn();
const setTmuxSocketNameMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  deleteJson: vi.fn(),
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
  ensureInstanceConfig: vi.fn(() => ({
    configPath: "/tmp/spur.yaml",
    initialized: false,
  })),
  findProjectConfigPath: vi.fn(),
  loadConfig: vi.fn(() => ({
    tmux: { socketName: "spur-test" },
  })),
  loadProjectConfig: vi.fn(),
  writeProjectConfigScaffold: vi.fn(),
}));

vi.mock("../../src/io.js", () => ({
  writeStderr: vi.fn(),
  writeStdout: writeStdoutMock,
}));

vi.mock("../../src/runtime-tmux.js", () => ({
  setTmuxSocketName: setTmuxSocketNameMock,
  sidecarTmuxSession: vi.fn((id: string, name: string) => `${id}--${name}`),
  withTmuxSocketArgs: vi.fn((args: string[]) => args),
}));

async function parseAutoPing(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

function outputText(): string {
  return writeStdoutMock.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("auto-ping CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset();
    postJsonMock.mockReset();
    writeStdoutMock.mockReset();
    setTmuxSocketNameMock.mockReset();
    delete process.env["SPUR_SESSION"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["SPUR_SESSION"];
  });

  it("posts an event unsubscribe with the session from SPUR_SESSION", async () => {
    process.env["SPUR_SESSION"] = "ses-1";
    postJsonMock.mockResolvedValue({
      record: { id: "sup-1", scope: "event", createdAt: "2026-09-01T00:00:00.000Z" },
      created: true,
    });

    await parseAutoPing(["auto-ping", "unsubscribe", "--event", "ap1_event"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/ses-1/auto-ping-suppressions/unsubscribe",
      { scope: "event", handle: "ap1_event" },
      "/tmp/spur.yaml",
    );
    expect(outputText()).toContain("Created auto-ping event suppression sup-1.");
  }, 15_000);

  it("requires exactly one unsubscribe scope flag", async () => {
    await expect(
      parseAutoPing([
        "auto-ping",
        "unsubscribe",
        "--event",
        "ap1_event",
        "--thread",
        "ap1_thread",
        "--session",
        "ses-1",
      ]),
    ).rejects.toThrow(/exactly one/);

    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("requires --session outside a Spur session", async () => {
    await expect(
      parseAutoPing(["auto-ping", "unsubscribe", "--subscription", "ap1_sub"]),
    ).rejects.toThrow(/--session is required/);

    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects a --session that differs from SPUR_SESSION", async () => {
    process.env["SPUR_SESSION"] = "ses-env";

    await expect(
      parseAutoPing([
        "auto-ping",
        "unsubscribe",
        "--subscription",
        "ap1_sub",
        "--session",
        "ses-other",
      ]),
    ).rejects.toThrow(/different session/);

    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("lists auto-ping suppressions for an explicit human target session", async () => {
    getJsonMock.mockResolvedValue({
      records: [
        {
          id: "sup-1",
          scope: "subscription",
          sourceType: "github",
          eventName: "github:comment",
          triggerId: "review-comments",
          destination: "ses-1",
        },
      ],
    });

    await parseAutoPing(["auto-ping", "list", "--session", "ses-1"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/ses-1/auto-ping-suppressions",
      "/tmp/spur.yaml",
    );
    expect(outputText()).toContain("sup-1\tsubscription\tactive\tgithub");
  });

  it("posts resume and preserves the raw JSON response under --json", async () => {
    postJsonMock.mockResolvedValue({
      records: [{ id: "sup-1", scope: "thread" }],
      removed: false,
    });

    await parseAutoPing(["auto-ping", "resume", "sup-1", "--session", "ses-1", "--json"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/ses-1/auto-ping-suppressions/sup-1/resume",
      {},
      "/tmp/spur.yaml",
    );
    expect(JSON.parse(outputText())).toEqual({
      records: [{ id: "sup-1", scope: "thread" }],
      removed: false,
    });
  });
});

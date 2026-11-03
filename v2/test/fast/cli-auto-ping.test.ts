import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";
import type { AutoPingMuteView } from "../../src/types.js";

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

vi.mock("../../src/runtime-tmux.js", async (importOriginal) => ({
  TmuxProbeUnknownError: (await importOriginal<typeof RuntimeTmuxModule>()).TmuxProbeUnknownError,
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

const HANDLE = `ap1_${"h".repeat(43)}`;

function mute(
  suppressionId: string,
  mode: AutoPingMuteView["mode"],
  overrides: Partial<AutoPingMuteView> = {},
): AutoPingMuteView {
  return {
    suppressionId,
    mode,
    routeFingerprint: "route-1",
    destination: { kind: "session", sessionId: "ses-1" },
    actorSessionId: "ses-1",
    items: [
      {
        subject: "review:github:o/r#7",
        kind: "ci_failed",
        label: "until next commit",
        changeKey: "head",
      },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
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

  it("posts an until-change mute with the session from SPUR_SESSION and renders the undo line", async () => {
    process.env["SPUR_SESSION"] = "ses-1";
    postJsonMock.mockResolvedValue({ record: mute("sup-1", "until_change"), created: true });

    await parseAutoPing(["auto-ping", "mute", HANDLE]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/ses-1/auto-ping-suppressions/mute",
      { handle: HANDLE, mode: "until_change" },
      "/tmp/spur.yaml",
    );
    expect(outputText()).toBe(
      `Muted ci_failed on PR #7 until next commit. Undo: "$SPUR_SESSION_TOOL_DIR/spur" auto-ping resume ${HANDLE}`,
    );
  }, 15_000);

  it("posts --for with a duration in milliseconds and a reason", async () => {
    process.env["SPUR_SESSION"] = "ses-1";
    postJsonMock.mockResolvedValue({
      record: mute("sup-2", "for", { expiresAt: "2026-09-01T02:00:00.000Z" }),
      created: true,
    });

    await parseAutoPing(["auto-ping", "mute", HANDLE, "--for", "2h", "--reason", "waiting"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/ses-1/auto-ping-suppressions/mute",
      { handle: HANDLE, mode: "for", durationMs: 7_200_000, reason: "waiting" },
      "/tmp/spur.yaml",
    );
    expect(outputText()).toContain("Muted ci_failed on PR #7 for 2h. Undo:");
  });

  it("posts --forever with a reason", async () => {
    process.env["SPUR_SESSION"] = "ses-1";
    postJsonMock.mockResolvedValue({ record: mute("sup-3", "forever"), created: true });

    await parseAutoPing(["auto-ping", "mute", HANDLE, "--forever", "--reason", "wrong trigger"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/ses-1/auto-ping-suppressions/mute",
      { handle: HANDLE, mode: "forever", reason: "wrong trigger" },
      "/tmp/spur.yaml",
    );
    expect(outputText()).toContain("Muted ci_failed on PR #7 forever. Undo:");
  });

  it("rejects missing reasons and durations over 24h before any request", async () => {
    process.env["SPUR_SESSION"] = "ses-1";
    await expect(parseAutoPing(["auto-ping", "mute", HANDLE, "--forever"])).rejects.toThrow(
      "--reason is required.",
    );
    await expect(parseAutoPing(["auto-ping", "mute", HANDLE, "--for", "2h"])).rejects.toThrow(
      "--reason is required.",
    );
    await expect(
      parseAutoPing(["auto-ping", "mute", HANDLE, "--for", "25h", "--reason", "x"]),
    ).rejects.toThrow("--for max is 24h.");
    await expect(
      parseAutoPing(["auto-ping", "mute", HANDLE, "--for", "2h", "--forever", "--reason", "x"]),
    ).rejects.toThrow(/only one of/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("requires --session outside a Spur session", async () => {
    await expect(parseAutoPing(["auto-ping", "mute", HANDLE])).rejects.toThrow(
      /--session is required/,
    );
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects a --session that differs from SPUR_SESSION", async () => {
    process.env["SPUR_SESSION"] = "ses-env";
    await expect(
      parseAutoPing(["auto-ping", "mute", HANDLE, "--session", "ses-other"]),
    ).rejects.toThrow(/different session/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("no longer offers unsubscribe", async () => {
    await expect(
      parseAutoPing(["auto-ping", "unsubscribe", "--event", HANDLE, "--session", "ses-1"]),
    ).rejects.toThrow();
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("lists active mutes with mode, kind, until label and reason", async () => {
    getJsonMock.mockResolvedValue({
      records: [
        mute("sup-list-1", "forever", { reason: "broken trigger" }),
        mute("sup-list-2", "until_change"),
      ],
    });

    await parseAutoPing(["auto-ping", "list", "--session", "ses-1"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/ses-1/auto-ping-suppressions",
      "/tmp/spur.yaml",
    );
    expect(outputText()).toContain(
      "sup-list-1\tforever\tci_failed\treview:github:o/r#7\tforever\tbroken trigger",
    );
    expect(outputText()).toContain("sup-list-2\tuntil_change\tci_failed");
    expect(outputText()).toContain("until next commit");
  });

  it("lists history with --all", async () => {
    getJsonMock.mockResolvedValue({
      records: [],
      history: [
        mute("old-1", "for", {
          expiresAt: "2026-09-01T02:00:00.000Z",
          endedAt: "2026-09-01T02:00:00.000Z",
          endReason: "expired",
        }),
      ],
    });

    await parseAutoPing(["auto-ping", "list", "--session", "ses-1", "--all"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/ses-1/auto-ping-suppressions?all=1",
      "/tmp/spur.yaml",
    );
    expect(outputText()).toContain("No active auto-ping mutes.");
    expect(outputText()).toContain("History:");
    expect(outputText()).toContain("old-1\tfor");
    expect(outputText()).toContain("ended expired 2026-09-01T02:00:00.000Z");
  });

  it("resumes by handle and by mute id", async () => {
    postJsonMock.mockResolvedValue({ records: [], removed: true });

    await parseAutoPing(["auto-ping", "resume", HANDLE, "--session", "ses-1"]);
    expect(postJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/ses-1/auto-ping-suppressions/resume",
      { handle: HANDLE },
      "/tmp/spur.yaml",
    );
    expect(outputText()).toContain(`Resumed auto-ping mute ${HANDLE}.`);

    await parseAutoPing(["auto-ping", "resume", "sup-9", "--session", "ses-1"]);
    expect(postJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/ses-1/auto-ping-suppressions/resume",
      { suppressionId: "sup-9" },
      "/tmp/spur.yaml",
    );
  });

  it("preserves the raw JSON response under --json", async () => {
    postJsonMock.mockResolvedValue({ records: [mute("sup-1", "forever")], removed: false });

    await parseAutoPing(["auto-ping", "resume", "sup-1", "--session", "ses-1", "--json"]);

    expect(JSON.parse(outputText())).toEqual({
      records: [mute("sup-1", "forever")],
      removed: false,
    });
  });
});

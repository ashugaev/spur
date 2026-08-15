import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getJsonMock = vi.fn();
const postJsonMock = vi.fn();
const writeStdoutMock = vi.fn();
const setTmuxSocketNameMock = vi.fn();

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

async function parseCli(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

// Deliberately out of sort order: "web" sorts after "echo", and within
// "echo" the port ids are reversed too, so the sort-by-sidecar-then-id
// assertion is not accidentally satisfied by fixture order.
const sessionView = {
  id: "api-1",
  sidecars: [
    {
      name: "web",
      alive: true,
      ports: [{ id: "http", env: "SPUR_RESERVED_PORT_WEB", port: 4100 }],
      tmuxSession: "api-1--web",
    },
    {
      name: "echo",
      alive: false,
      ports: [
        { id: "ws", env: "SPUR_RESERVED_PORT_ECHO_WS", port: 8931 },
        { id: "http", env: "SPUR_RESERVED_PORT_ECHO", port: 8930 },
      ],
      tmuxSession: "api-1--echo",
    },
    {
      name: "empty",
      alive: true,
      ports: [],
      tmuxSession: "api-1--empty",
    },
  ],
};

const noPortsSessionView = {
  id: "api-1",
  sidecars: [{ name: "empty", alive: true, ports: [], tmuxSession: "api-1--empty" }],
};

describe("sidecar ports CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset();
    postJsonMock.mockReset();
    writeStdoutMock.mockReset();
    setTmuxSocketNameMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints one tab-separated row per reserved port, sorted by sidecar then port id", async () => {
    getJsonMock.mockResolvedValue(sessionView);

    await parseCli(["sidecar", "ports", "--session", "api-1"]);

    expect(writeStdoutMock.mock.calls.map((call) => call[0] as string)).toEqual([
      "echo\thttp\tSPUR_RESERVED_PORT_ECHO\t8930\tdead",
      "echo\tws\tSPUR_RESERVED_PORT_ECHO_WS\t8931\tdead",
      "web\thttp\tSPUR_RESERVED_PORT_WEB\t4100\talive",
    ]);
  });

  it("prints nothing when no sidecar has a reserved port", async () => {
    getJsonMock.mockResolvedValue(noPortsSessionView);

    await parseCli(["sidecar", "ports", "--session", "api-1"]);

    expect(writeStdoutMock).not.toHaveBeenCalled();
  });

  it("prints [] in --json mode when no sidecar has a reserved port", async () => {
    getJsonMock.mockResolvedValue(noPortsSessionView);

    await parseCli(["sidecar", "ports", "--session", "api-1", "--json"]);

    expect(writeStdoutMock).toHaveBeenCalledWith("[]");
  });

  it("prints sidecar/id/env/port/alive objects in --json mode", async () => {
    getJsonMock.mockResolvedValue(sessionView);

    await parseCli(["sidecar", "ports", "--session", "api-1", "--json"]);

    expect(writeStdoutMock).toHaveBeenCalledWith(
      JSON.stringify(
        [
          { sidecar: "echo", id: "http", env: "SPUR_RESERVED_PORT_ECHO", port: 8930, alive: false },
          {
            sidecar: "echo",
            id: "ws",
            env: "SPUR_RESERVED_PORT_ECHO_WS",
            port: 8931,
            alive: false,
          },
          { sidecar: "web", id: "http", env: "SPUR_RESERVED_PORT_WEB", port: 4100, alive: true },
        ],
        null,
        2,
      ),
    );
  });

  it("restricts output to --name", async () => {
    getJsonMock.mockResolvedValue(sessionView);

    await parseCli(["sidecar", "ports", "--session", "api-1", "--name", "web"]);

    expect(writeStdoutMock.mock.calls.map((call) => call[0] as string)).toEqual([
      "web\thttp\tSPUR_RESERVED_PORT_WEB\t4100\talive",
    ]);
  });

  it("rejects an unknown --name", async () => {
    getJsonMock.mockResolvedValue(sessionView);

    await expect(
      parseCli(["sidecar", "ports", "--session", "api-1", "--name", "nope"]),
    ).rejects.toThrow('Session api-1 has no sidecar "nope"');
    expect(writeStdoutMock).not.toHaveBeenCalled();
  });

  it("reads GET /sessions/<id> once and never POSTs", async () => {
    getJsonMock.mockResolvedValue(sessionView);

    await parseCli(["sidecar", "ports", "--session", "api-1"]);

    expect(getJsonMock).toHaveBeenCalledTimes(1);
    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1",
      "/tmp/spur.yaml",
    );
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("prints a desk sibling's anchor-owned sidecar ports", async () => {
    // The fixture below stands in for a desk SIBLING's own GET /sessions/:id
    // response: it already carries the anchor's owner-resolved ports and
    // alive state (session-service.ts:13442-13455 does that server-side).
    // The CLI performs no owner lookup of its own — it only flattens what
    // the view already contains.
    const siblingView = {
      id: "api-2",
      sidecars: [
        {
          name: "daemon",
          alive: true,
          ports: [{ id: "http", env: "SPUR_RESERVED_PORT_DAEMON", port: 4100 }],
          tmuxSession: "api-1--daemon",
        },
      ],
    };
    getJsonMock.mockResolvedValue(siblingView);

    await parseCli(["sidecar", "ports", "--session", "api-2"]);

    expect(writeStdoutMock).toHaveBeenCalledWith(
      "daemon\thttp\tSPUR_RESERVED_PORT_DAEMON\t4100\talive",
    );
  });
});

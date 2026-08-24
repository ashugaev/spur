import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "../../src/config.js";
import type * as WorkspaceModule from "../../src/workspace.js";

const { loadInstanceConfigReadOnlyMock, collectHostInstallChecksMock, writeStdoutMock } =
  vi.hoisted(() => ({
    loadInstanceConfigReadOnlyMock: vi.fn(),
    collectHostInstallChecksMock: vi.fn(),
    writeStdoutMock: vi.fn(),
  }));

vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual<typeof ConfigModule>("../../src/config.js");
  return {
    ...actual,
    loadInstanceConfigReadOnly: loadInstanceConfigReadOnlyMock,
    findProjectConfigPathInDirectory: vi.fn(() => undefined),
    createProjectConfigScaffold: vi.fn(),
    writeProjectConfigScaffold: vi.fn(),
  };
});

vi.mock("../../src/host-install.js", () => ({
  collectHostInstallChecks: collectHostInstallChecksMock,
  hasErrorSeverity: vi.fn(() => false),
  renderHostInstallChecks: vi.fn(() => ""),
  runNpmInit: vi.fn(),
}));

vi.mock("../../src/workspace.js", async () => {
  const actual = await vi.importActual<typeof WorkspaceModule>("../../src/workspace.js");
  return { ...actual, resolveDoctorRepoRoot: vi.fn(async (cwd: string) => cwd) };
});

vi.mock("../../src/io.js", () => ({
  writeStderr: vi.fn(),
  writeStdout: writeStdoutMock,
}));

async function parseDoctor(args: string[], globalArgs: string[] = []): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync([
    "node",
    "spur",
    ...globalArgs,
    "doctor",
    ...args,
  ]);
}

describe("spur doctor CLI --config forwarding", () => {
  beforeEach(() => {
    vi.resetModules();
    loadInstanceConfigReadOnlyMock.mockReset();
    collectHostInstallChecksMock.mockReset();
    writeStdoutMock.mockReset();
    collectHostInstallChecksMock.mockResolvedValue([]);
    loadInstanceConfigReadOnlyMock.mockReturnValue({ status: "absent" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards --config path to loadInstanceConfigReadOnly", async () => {
    const selectedPath = "/nonexistent/custom-spur.yaml";
    let capturedInput: string | undefined;
    loadInstanceConfigReadOnlyMock.mockImplementation((input?: string) => {
      capturedInput = input;
      return { status: "absent" };
    });
    await parseDoctor([], ["--config", selectedPath]);
    expect(capturedInput).toBe(selectedPath);
  });

  it("uses absent selected config without falling back to default", async () => {
    const selectedPath = "/nonexistent/custom-spur.yaml";
    loadInstanceConfigReadOnlyMock.mockImplementation((input?: string) => {
      if (input === selectedPath) return { status: "absent" };
      return {
        status: "ok",
        config: {
          dataDir: "/should-not-be-used/.spur",
          worktreeDir: "/should-not-be-used/.spur/worktrees",
          tmux: { socketName: "spur-test" },
          projects: {},
        },
      };
    });
    await parseDoctor([], ["--config", selectedPath]);
    expect(loadInstanceConfigReadOnlyMock).toHaveBeenCalledWith(selectedPath);
    expect(loadInstanceConfigReadOnlyMock).toHaveBeenCalledTimes(1);
  });
});

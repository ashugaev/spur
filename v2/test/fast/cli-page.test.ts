import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const getJsonMock = vi.fn();
const postJsonMock = vi.fn();
const deleteJsonMock = vi.fn();
const writeStdoutMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  deleteJson: deleteJsonMock,
  disconnectProjectConfig: vi.fn(),
  getJson: getJsonMock,
  listProjects: vi.fn(),
  patchJson: vi.fn(),
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

async function page(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", "page", ...args]);
}

const films = {
  id: "films",
  title: "Films",
  agent: { runtime: "claude" },
  path: "/data/pages/films",
  url: "/p/films/",
};

describe("spur page", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of [getJsonMock, postJsonMock, deleteJsonMock, writeStdoutMock])
      mock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("creates with title, runtime, model and the blank template", async () => {
    postJsonMock.mockResolvedValue(films);
    await page([
      "create",
      "films",
      "--title",
      "Films",
      "--runtime",
      "codex",
      "--model",
      "gpt-5",
      "--json",
    ]);
    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/pages",
      { id: "films", template: "blank", title: "Films", runtime: "codex", model: "gpt-5" },
      "/tmp/spur.yaml",
    );
  });

  it("lists pages and prints one page path", async () => {
    getJsonMock.mockResolvedValue({ pages: [films] });
    await page(["list"]);
    expect(writeStdoutMock).toHaveBeenLastCalledWith("films  Films  /p/films/  /data/pages/films");
    await page(["path", "films"]);
    expect(writeStdoutMock).toHaveBeenLastCalledWith("/data/pages/films");
    await expect(page(["path", "other"])).rejects.toThrow("Page not found: other");
  });

  it("rm hits DELETE /pages/<id>", async () => {
    deleteJsonMock.mockResolvedValue({ deleted: true, id: "films" });
    await page(["rm", "films"]);
    expect(deleteJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/pages/films",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenLastCalledWith("Removed page films.");
  });

  it("rejects a missing id and unknown actions", async () => {
    await expect(page(["rm"])).rejects.toThrow("page rm requires an id");
    await expect(page(["open", "films"])).rejects.toThrow("page action must be");
    expect(deleteJsonMock).not.toHaveBeenCalled();
  });
});

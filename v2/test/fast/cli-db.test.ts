import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const getJsonMock = vi.fn();
const postJsonMock = vi.fn();
const patchJsonMock = vi.fn();
const deleteJsonMock = vi.fn();
const writeStdoutMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  deleteJson: deleteJsonMock,
  disconnectProjectConfig: vi.fn(),
  getJson: getJsonMock,
  listProjects: vi.fn(),
  patchJson: patchJsonMock,
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

async function db(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", "db", ...args]);
}

const doc = { id: "d1", rev: 2, createdAt: "t", updatedAt: "t", data: { title: "Dune" } };

describe("spur db", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of [
      getJsonMock,
      postJsonMock,
      patchJsonMock,
      deleteJsonMock,
      writeStdoutMock,
    ]) {
      mock.mockReset();
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("gets a document with the store id encoded", async () => {
    getJsonMock.mockResolvedValue(doc);
    await db(["page:films", "get", "items", "d1", "--json"]);
    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/stores/page%3Afilms/docs/items/d1",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenCalledWith(JSON.stringify(doc, null, 2));
  });

  it("lists with limit and cursor", async () => {
    getJsonMock.mockResolvedValue({ docs: [doc] });
    await db(["session:sp-1", "list", "items", "--limit", "5", "--start-after", "d0"]);
    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/stores/session%3Asp-1/docs/items?limit=5&startAfter=d0",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenCalledWith(
      JSON.stringify({ id: "d1", rev: 2, data: { title: "Dune" } }),
    );
  });

  it("posts a query body", async () => {
    postJsonMock.mockResolvedValue({ docs: [] });
    const query = { where: [{ field: "watched", op: "==", value: false }] };
    await db(["page:films", "query", "items", JSON.stringify(query), "--json"]);
    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/stores/page%3Afilms/query/items",
      query,
      "/tmp/spur.yaml",
    );
  });

  it("adds, sets with --rev, updates with PATCH and removes with expectedRev", async () => {
    postJsonMock.mockResolvedValue(doc);
    patchJsonMock.mockResolvedValue(doc);
    deleteJsonMock.mockResolvedValue({ deleted: true });
    await db(["page:films", "add", "items", '{"title":"Dune"}', "--json"]);
    expect(postJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/stores/page%3Afilms/docs/items",
      { data: { title: "Dune" } },
      "/tmp/spur.yaml",
    );
    await db(["page:films", "set", "items", "d1", '{"title":"Arrival"}', "--rev", "1", "--json"]);
    expect(postJsonMock).toHaveBeenLastCalledWith(
      "/tmp/dist/cli.js",
      "/stores/page%3Afilms/docs/items/d1",
      { data: { title: "Arrival" }, expectedRev: 1 },
      "/tmp/spur.yaml",
    );
    await db(["page:films", "update", "items", "d1", '{"watched":true}', "--json"]);
    expect(patchJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/stores/page%3Afilms/docs/items/d1",
      { data: { watched: true } },
      "/tmp/spur.yaml",
    );
    await db(["page:films", "rm", "items", "d1", "--rev", "3"]);
    expect(deleteJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/stores/page%3Afilms/docs/items/d1?expectedRev=3",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenLastCalledWith("Removed items/d1.");
  });

  it("rejects bad JSON, bad arity, bad --rev and unknown ops before any request", async () => {
    await expect(db(["page:films", "add", "items", "{nope"])).rejects.toThrow(
      "document must be valid JSON",
    );
    await expect(db(["page:films", "get", "items"])).rejects.toThrow("Usage: spur db <store> get");
    await expect(db(["page:films", "set", "items", "d1", "{}", "--rev", "x"])).rejects.toThrow(
      "--rev must be a non-negative integer",
    );
    await expect(db(["page:films", "drop", "items"])).rejects.toThrow("db op must be");
    expect(postJsonMock).not.toHaveBeenCalled();
    expect(getJsonMock).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const getJsonMock = vi.fn();

vi.mock("../../src/client.js", () => ({ getJson: getJsonMock }));
vi.mock("../../src/config.js", () => ({
  ensureInstanceConfig: vi.fn(() => ({ configPath: "/tmp/spur.yaml", initialized: false })),
  findProjectConfigPath: vi.fn(),
  loadConfig: vi.fn(() => ({ tmux: { socketName: "spur-test" } })),
}));
vi.mock("../../src/io.js", () => ({ writeStderr: vi.fn(), writeStdout: vi.fn() }));

async function list(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", "list", ...args]);
}

describe("spur list filters", () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset().mockResolvedValue([]);
  });

  it("keeps the default JSON request unchanged", async () => {
    await list(["--json"]);
    expect(getJsonMock).toHaveBeenCalledWith("/tmp/dist/cli.js", "/sessions", "/tmp/spur.yaml");
  });

  it("sends completed inclusion and every repeated link predicate", async () => {
    await list([
      "--json",
      "--all",
      "--link",
      "board-task=https://example.com/task?a=b",
      "--link",
      "board-role=https://example.com/role/reviewer",
    ]);
    const path = getJsonMock.mock.calls[0]?.[1] as string;
    const query = new URL(path, "http://localhost").searchParams;
    expect(query.get("includeCompleted")).toBe("1");
    expect(query.getAll("link")).toEqual([
      "board-task=https://example.com/task?a=b",
      "board-role=https://example.com/role/reviewer",
    ]);
  });

  it("rejects filter flags outside JSON mode", async () => {
    await expect(list(["--all"])).rejects.toThrow("require --json");
    await expect(list(["--link", "board-task"])).rejects.toThrow("require --json");
    expect(getJsonMock).not.toHaveBeenCalled();
  });
});

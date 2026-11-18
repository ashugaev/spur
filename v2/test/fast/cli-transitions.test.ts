import { beforeEach, describe, expect, it, vi } from "vitest";

const getJsonMock = vi.fn();
const writeStdoutMock = vi.fn();

vi.mock("../../src/client.js", () => ({ getJson: getJsonMock }));
vi.mock("../../src/config.js", () => ({
  ensureInstanceConfig: vi.fn(() => ({ configPath: "/tmp/spur.yaml", initialized: false })),
  loadConfig: vi.fn(() => ({ tmux: { socketName: "spur-test" } })),
}));
vi.mock("../../src/io.js", () => ({ writeStderr: vi.fn(), writeStdout: writeStdoutMock }));

const envelope = { entries: [], nextCursor: "opaque.1", hasMore: false };

async function transitions(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", "transitions", ...args]);
}

describe("spur transitions", () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset().mockResolvedValue(envelope);
    writeStdoutMock.mockReset();
  });

  it("returns the whole cursor envelope without list auto-connect", async () => {
    await transitions(["--json"]);
    expect(getJsonMock).toHaveBeenCalledExactlyOnceWith(
      "/tmp/dist/cli.js",
      "/sessions/transitions",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenCalledWith(JSON.stringify(envelope, null, 2));
  });

  it("forwards cursor, kinds, limit and every S5 link predicate", async () => {
    await transitions([
      "--since",
      "opaque&cursor=1",
      "--limit",
      "1",
      "--kinds",
      "status,state",
      "--link",
      "board-task=https://example.com/task?a=b",
      "--link",
      "board-role=https://example.com/role/reviewer",
      "--json",
    ]);
    const path = getJsonMock.mock.calls[0]?.[1] as string;
    const query = new URL(path, "http://localhost").searchParams;
    expect(query.get("since")).toBe("opaque&cursor=1");
    expect(query.get("limit")).toBe("1");
    expect(query.get("kinds")).toBe("status,state");
    expect(query.getAll("link")).toEqual([
      "board-task=https://example.com/task?a=b",
      "board-role=https://example.com/role/reviewer",
    ]);
  });

  it("prints the continuation cursor and hasMore in plain output", async () => {
    getJsonMock.mockResolvedValueOnce({
      entries: [
        {
          cursor: "opaque.1",
          sessionId: "test-one",
          project: "test",
          at: "2026-11-14T00:00:00.000Z",
          kind: "status",
          from: "running",
          to: "completed",
          links: [],
        },
      ],
      nextCursor: "opaque.1",
      hasMore: true,
    });
    await transitions([]);
    const output = writeStdoutMock.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("test-one status running -> completed");
    expect(output).toContain("nextCursor: opaque.1");
    expect(output).toContain("hasMore: true");
  });

  it("propagates daemon cursor failures without a second request", async () => {
    getJsonMock.mockRejectedValueOnce(new Error("Expired transitions cursor"));
    await expect(transitions(["--since", "expired", "--json"])).rejects.toThrow("Expired");
    expect(getJsonMock).toHaveBeenCalledTimes(1);
  });
});

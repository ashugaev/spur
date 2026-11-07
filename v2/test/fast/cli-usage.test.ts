import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "../../src/usage-report.js";

const getJsonMock = vi.fn();
const writeStdoutMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  deleteJson: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: getJsonMock,
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

vi.mock("../../src/io.js", () => ({ writeStderr: vi.fn(), writeStdout: writeStdoutMock }));

const totals = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
const report: UsageReport = {
  generatedAt: "2026-11-06T12:00:00.000Z",
  quotas: [
    {
      provider: "claude",
      source: "default",
      label: "default",
      fetchedAt: "2026-11-06T12:00:00.000Z",
      status: "ok",
      plan: "max",
      windows: [
        { label: "5h", usedPercent: 12, remainingPercent: 88, resetsAt: "2026-11-06T15:00:00Z" },
      ],
    },
    {
      provider: "codex",
      source: "codex",
      label: "codex",
      fetchedAt: "2026-11-06T12:00:00.000Z",
      status: "error",
      error: "no_credentials",
      message: "no saved login found",
      httpStatus: null,
    },
  ],
  tokens: [
    {
      window: "today",
      since: "2026-11-06T00:00:00.000Z",
      byProvider: [
        {
          provider: "claude",
          sessionCount: 1,
          totals,
          byModel: [{ model: null, sessionCount: 1, totals }],
        },
      ],
    },
  ],
};

async function run(args: string[]): Promise<string> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
  return writeStdoutMock.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("spur usage", () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset();
    writeStdoutMock.mockReset();
    getJsonMock.mockResolvedValue(report);
  });

  it("renders ok rows, error rows and token windows", async () => {
    const out = await run(["usage"]);
    expect(getJsonMock).toHaveBeenCalledWith(expect.anything(), "/usage", "/tmp/spur.yaml");
    expect(out).toContain("claude default");
    expect(out).toContain("12% used");
    expect(out).toContain("88% left");
    expect(out).toContain("no_credentials");
    expect(out).toContain("today");
    expect(out).toContain("default");
    expect(out).toContain("3 tokens");
  });

  it("prints the raw report with --json", async () => {
    const out = await run(["usage", "--json"]);
    expect(JSON.parse(out)).toEqual(report);
  });
});

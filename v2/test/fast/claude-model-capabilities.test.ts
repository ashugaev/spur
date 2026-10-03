import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import {
  discoverClaudeModelCapabilities,
  parseClaudeModelCapabilities,
} from "../../src/agents/claude.js";

function nativeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    }),
  });
  return child;
}

const rows = [
  {
    value: "sonnet",
    resolvedModel: "resolved-sonnet",
    displayName: "Sonnet",
    supportsEffort: true,
    supportedEffortLevels: ["high", "max"],
  },
  { value: "haiku", displayName: "Haiku" },
];

beforeEach(() => {
  spawnMock.mockReset();
  process.env["SPUR_CLAUDE_BIN"] = `claude-capabilities-${Math.random()}`;
});
afterEach(() => {
  delete process.env["SPUR_CLAUDE_BIN"];
  vi.useRealTimers();
});

describe("Claude initialize model capabilities", () => {
  it("accepts native unsupported rows without optional effort metadata", () => {
    expect(parseClaudeModelCapabilities(rows)).toEqual([
      rows[0],
      { value: "haiku", displayName: "Haiku", supportsEffort: false, supportedEffortLevels: [] },
    ]);
  });
  it("treats an older catalog without any effort metadata as unavailable", () => {
    expect(() =>
      parseClaudeModelCapabilities([{ value: "sonnet", displayName: "Sonnet" }]),
    ).toThrow("capabilities unavailable");
  });
  it("rejects a present malformed effort flag", () => {
    expect(() =>
      parseClaudeModelCapabilities([
        ...rows,
        { value: "custom", displayName: "Custom", supportsEffort: "false" },
      ]),
    ).toThrow("Malformed");
  });
  it("discovers without a user turn, deduplicates and cleans its child/cwd before resolving", async () => {
    const child = nativeChild();
    let input = "";
    child.stdin.on("data", (chunk: Buffer) => {
      input += chunk.toString();
    });
    spawnMock.mockReturnValue(child);
    const first = discoverClaudeModelCapabilities();
    const second = discoverClaudeModelCapabilities();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const [, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(args).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--tools",
      "",
    ]);
    expect(options.env["DISABLE_AUTO_UPDATE"]).toBe("1");
    expect(JSON.parse(input)).toEqual({
      type: "control_request",
      request_id: "spur-model-caps",
      request: { subtype: "initialize", hooks: {} },
    });
    child.stdout.write(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "other", response: {} },
      }) + "\n",
    );
    const response =
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "spur-model-caps", response: { models: rows } },
      }) + "\n";
    child.stdout.write(response.slice(0, 17));
    child.stdout.write(response.slice(17));
    const [models, concurrent] = await Promise.all([first, second]);
    expect(models).toEqual([
      rows[0],
      { ...rows[1], supportsEffort: false, supportedEffortLevels: [] },
    ]);
    expect(concurrent).toEqual(models);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(access(options.cwd)).rejects.toThrow();
    expect(await discoverClaudeModelCapabilities()).toEqual(models);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not poison future discovery after malformed data", async () => {
    const child = nativeChild();
    spawnMock.mockReturnValue(child);
    const request = discoverClaudeModelCapabilities();
    const rejection = expect(request).rejects.toThrow("Malformed");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    child.stdout.write("{broken}\n");
    await rejection;
    const retryChild = nativeChild();
    spawnMock.mockReturnValue(retryChild);
    const retry = discoverClaudeModelCapabilities();
    const retryRejection = expect(retry).rejects.toThrow("unavailable");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    retryChild.emit("close", 1);
    await retryRejection;
  });

  it("bounds hung initialization and removes its temporary cwd", async () => {
    vi.useFakeTimers();
    const child = nativeChild();
    spawnMock.mockReturnValue(child);
    const request = discoverClaudeModelCapabilities();
    const rejection = expect(request).rejects.toThrow("timed out");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    const [, , options] = spawnMock.mock.calls[0] as [string, string[], { cwd: string }];
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(access(options.cwd)).rejects.toThrow();
  }, 8_000);

  it.each([
    null,
    {},
    [{ value: "bad", displayName: "Bad", supportsEffort: true }],
    [{ value: "bad", displayName: "Bad", supportsEffort: true, supportedEffortLevels: [null] }],
  ])("rejects malformed capability payload %j", (value) => {
    expect(() => parseClaudeModelCapabilities(value)).toThrow();
  });
});

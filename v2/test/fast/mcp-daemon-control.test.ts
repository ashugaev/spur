import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDir } from "../helpers/common.js";
import { McpDaemonControl } from "../../src/mcp-daemon-control.js";
import { restartDaemonIfRunning } from "../../src/client.js";
import { readUserActionLog } from "../../src/user-action-log.js";

vi.mock("../../src/client.js", () => ({ restartDaemonIfRunning: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const identity = { pid: 12345, lifecycleInstanceId: "before" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it("admits once across MCP hosts, retains the receipt and audit, reconciles a ready new generation", async () => {
  const data = await createTempDir("mcp-control-");
  vi.mocked(restartDaemonIfRunning).mockResolvedValue({
    baseUrl: "http://localhost",
    restarted: true,
  });
  const first = new McpDaemonControl(data, join(data, "config.yaml"));
  const second = new McpDaemonControl(data, join(data, "config.yaml"));
  const id = randomUUID();
  expect(first.accept(id, identity)).toMatchObject({
    duplicate: false,
    receipt: { status: "accepted", operationId: id },
  });
  expect(second.accept(id, identity)).toMatchObject({ duplicate: true });
  expect(() => second.accept(randomUUID(), identity)).toThrow(`original operation ${id}`);
  await tick();
  expect(restartDaemonIfRunning).toHaveBeenCalledTimes(1);
  expect(restartDaemonIfRunning).toHaveBeenCalledWith(
    expect.stringMatching(/cli\.js$/),
    join(data, "config.yaml"),
    identity.pid,
  );
  expect(readUserActionLog(data)).toMatchObject([
    { origin: "mcp", action: "daemon.restart", params: { operationId: id } },
  ]);
  expect(second.get(id, { pid: 12346, lifecycleInstanceId: "after" })).toMatchObject({
    status: "completed",
    instanceId: "after",
    dispatchedAt: expect.any(String),
  });
  expect(
    JSON.parse(readFileSync(join(data, "mcp-operator-actions", `${id}.json`), "utf8")),
  ).toMatchObject({ status: "completed" });
  expect(second.accept(id, { pid: 12346, lifecycleInstanceId: "after" }).duplicate).toBe(true);
  expect(restartDaemonIfRunning).toHaveBeenCalledTimes(1);
});

it("keeps unknown effects on the original resolver and blocks a replacement restart", async () => {
  const data = await createTempDir("mcp-unknown-");
  vi.mocked(restartDaemonIfRunning).mockRejectedValue(new Error("disconnected"));
  const control = new McpDaemonControl(data, join(data, "config.yaml"));
  const id = randomUUID();
  control.accept(id, identity);
  await tick();
  expect(control.get(id)).toMatchObject({ status: "unknown" });
  expect(control.accept(id, identity).duplicate).toBe(true);
  expect(() => control.accept(randomUUID(), identity)).toThrow(id);
  expect(control.get(randomUUID())).toBeUndefined();
  expect(() => control.get("../../escape")).toThrow();
  expect(restartDaemonIfRunning).toHaveBeenCalledTimes(1);
});

it("fails closed on a crashed admission lock", async () => {
  const data = await createTempDir("mcp-lock-");
  const control = new McpDaemonControl(data, join(data, "config.yaml"));
  mkdirSync(join(data, "mcp-operator-actions", "admission.lock"));
  expect(() => control.accept(randomUUID(), identity)).toThrow();
  expect(restartDaemonIfRunning).not.toHaveBeenCalled();
});

it("marks expired admission unknown and never dispatches it later", async () => {
  const data = await createTempDir("mcp-expired-");
  const control = new McpDaemonControl(data, join(data, "config.yaml"));
  const id = randomUUID();
  vi.useFakeTimers();
  try {
    control.accept(id, identity);
    vi.setSystemTime(Date.now() + 90_001);
    expect(control.get(id)).toMatchObject({ status: "unknown" });
    await vi.runAllTimersAsync();
    expect(restartDaemonIfRunning).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("blocks another restart while the original lifecycle worker still has effects in flight", async () => {
  const data = await createTempDir("mcp-inflight-");
  const control = new McpDaemonControl(data, join(data, "config.yaml"));
  let finish: (() => void) | undefined;
  vi.mocked(restartDaemonIfRunning).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ restarted: true, baseUrl: "http://localhost" });
      }),
  );
  const id = randomUUID();
  control.accept(id, identity);
  await tick();
  const recovered = { pid: 12346, lifecycleInstanceId: "after" };
  expect(control.get(id, recovered)?.status).toBe("accepted");
  expect(() => control.accept(randomUUID(), recovered)).toThrow(id);
  expect(finish).toBeTypeOf("function");
  finish?.();
  await tick();
  expect(control.get(id, recovered)?.status).toBe("completed");
});

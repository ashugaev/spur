import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEventLog } from "../../src/event-log.js";
import { startServer, type StartedServer } from "../../src/server.js";
import { SessionService } from "../../src/session-service.js";
import { SessionTransitionsCursorError } from "../../src/session-transitions.js";
import { findFreePort } from "../helpers/common.js";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(): Promise<{ server: StartedServer; base: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "spur-transitions-server-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const port = await findFreePort();
  const configPath = join(root, "config.yaml");
  await writeFile(
    configPath,
    `server: {host: 127.0.0.1, port: ${port}}\ndataDir: ${join(root, "data")}\nworktreeDir: ${join(root, "worktrees")}\n`,
  );
  const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
  cleanups.push(() => server.stop());
  return { server, base: `http://127.0.0.1:${port}`, dataDir: join(root, "data") };
}

describe("GET /sessions/transitions", () => {
  it("dispatches before generic lookup and preserves the cursor envelope", async () => {
    const envelope = {
      entries: [],
      nextCursor: "opaque.1",
      hasMore: true,
    };
    const feed = vi
      .spyOn(SessionService.prototype, "listSessionTransitions")
      .mockResolvedValue(envelope);
    const get = vi.spyOn(SessionService.prototype, "get");
    const { base } = await setup();
    const query = new URLSearchParams({ since: "opaque.0", kinds: "status,state", limit: "1" });
    query.append("link", "Github_PR=https://example.com/task?a=b");
    query.append("link", "board-role");
    const response = await fetch(`${base}/sessions/transitions?${query}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(envelope);
    expect(feed).toHaveBeenCalledExactlyOnceWith({
      since: "opaque.0",
      kinds: ["status", "state"],
      limit: 1,
      links: [{ label: "pr", url: "https://example.com/task?a=b" }, { label: "board-role" }],
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects invalid boundary inputs before a classification pass", async () => {
    const feed = vi.spyOn(SessionService.prototype, "listSessionTransitions");
    const { base } = await setup();
    for (const query of [
      "limit=0",
      "limit=1001",
      "limit=1.5",
      "limit=nope",
      "kinds=unknown",
      "kinds=",
      "link=board-role%3Dbare-role",
      "link=%21invalid",
    ]) {
      const response = await fetch(`${base}/sessions/transitions?${query}`);
      expect(response.status, query).toBe(400);
    }
    expect(feed).not.toHaveBeenCalled();
  });

  it("preserves invalid and expired cursor errors without successful empty data", async () => {
    const feed = vi.spyOn(SessionService.prototype, "listSessionTransitions");
    const { base } = await setup();
    feed.mockRejectedValueOnce(new SessionTransitionsCursorError("Invalid cursor", 400));
    const invalid = await fetch(`${base}/sessions/transitions?since=bad`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Invalid cursor" });

    feed.mockRejectedValueOnce(
      new SessionTransitionsCursorError("Expired cursor", 410, "opaque.10", "opaque.20"),
    );
    const expired = await fetch(`${base}/sessions/transitions?since=old`);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({
      error: "Expired cursor",
      floorCursor: "opaque.10",
      latestCursor: "opaque.20",
    });
  });

  it("writes one http.request.slow event for a request above the threshold", async () => {
    const realNow = performance.now.bind(performance);
    const clock = vi.spyOn(performance, "now");
    vi.spyOn(SessionService.prototype, "listSessionTransitions").mockImplementation(async () => {
      clock.mockImplementation(() => realNow() + 5_000);
      return { entries: [], nextCursor: "opaque.1", hasMore: false };
    });
    const { base, dataDir } = await setup();
    const slowEvents = () => readEventLog(dataDir).filter((e) => e.event === "http.request.slow");
    expect((await fetch(`${base}/sessions/transitions?since=opaque.1`)).status).toBe(200);
    expect((await fetch(`${base}/info`)).status).toBe(200);
    expect(slowEvents()).toEqual([
      expect.objectContaining({
        level: "warn",
        method: "GET",
        path: "/sessions/transitions",
        details: { durationMs: expect.any(Number), statusCode: 200 },
      }),
    ]);
    expect(slowEvents()[0]?.details?.durationMs).toBeGreaterThanOrEqual(5_000);
  });

  it("fails the request on refresh or journal errors", async () => {
    vi.spyOn(SessionService.prototype, "listSessionTransitions").mockRejectedValue(
      new Error("Journal append failed"),
    );
    const { base } = await setup();
    const response = await fetch(`${base}/sessions/transitions`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Journal append failed" });
  });
});

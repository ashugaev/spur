import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDirectTerminalServer } from "../../server/direct-terminal-ws";

// Exercises the WebSocket-upgrade routing introduced when the terminal socket
// moved onto the shared web server. Connection handling beyond the path guard
// (pty spawn, tmux attach) needs a live tmux and node-pty and is not covered here.
describe("attachDirectTerminalWebSocket", () => {
  let terminal: ReturnType<typeof createDirectTerminalServer>;
  let port: number;

  beforeEach(async () => {
    terminal = createDirectTerminalServer();
    await new Promise<void>((resolve) => terminal.server.listen(0, "127.0.0.1", resolve));
    port = (terminal.server.address() as AddressInfo).port;
  });

  afterEach(() => {
    terminal.close();
  });

  it("accepts and then closes a /ws upgrade (connection handler runs)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=`);
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2_000);
      ws.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(closed).toBe(true);
  });

  it("ignores upgrades on other paths", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/not-the-terminal`);
    ws.on("error", () => {}); // absorb the close-before-open error on cleanup
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 400);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    ws.terminate();
    expect(opened).toBe(false);
  });
});

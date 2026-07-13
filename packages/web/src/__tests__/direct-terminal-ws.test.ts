import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachDirectTerminalWebSocket } from "../../server/direct-terminal-ws";

// Exercises the WebSocket-upgrade routing introduced when the terminal socket
// moved onto the shared web server. Connection handling beyond the path guard
// (pty spawn, tmux attach) needs a live tmux and node-pty and is not covered here.
describe("attachDirectTerminalWebSocket", () => {
  let server: Server;
  let attached: ReturnType<typeof attachDirectTerminalWebSocket>;
  let port: number;

  beforeEach(async () => {
    server = createServer((_request, response) => {
      response.writeHead(404);
      response.end("Not found");
    });
    attached = attachDirectTerminalWebSocket(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    attached.close();
    server.close();
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

  it("destroys upgrades on other paths instead of leaking the socket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/not-the-terminal`);
    // No fallbackUpgrade configured, so the dispatcher must destroy the socket:
    // the client sees an error/close, never an open.
    const result = await new Promise<"open" | "error" | "close">((resolve) => {
      const timer = setTimeout(() => resolve("open"), 1_000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve("open");
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve("error");
      });
      ws.on("close", () => {
        clearTimeout(timer);
        resolve("close");
      });
    });
    ws.terminate();
    expect(result).not.toBe("open");
  });

  it("forwards non-/ws upgrades to the configured fallback handler", async () => {
    const fallbackServer = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const fallbackPaths: string[] = [];
    const fallbackAttached = attachDirectTerminalWebSocket(fallbackServer, {
      fallbackUpgrade: (request, socket) => {
        fallbackPaths.push(new URL(request.url ?? "/", "ws://127.0.0.1").pathname);
        socket.destroy();
      },
    });
    await new Promise<void>((resolve) => fallbackServer.listen(0, "127.0.0.1", resolve));
    const fallbackPort = (fallbackServer.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${fallbackPort}/_next/webpack-hmr`);
    ws.on("error", () => {});
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 800);
      ws.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    ws.terminate();
    fallbackAttached.close();
    fallbackServer.close();

    expect(fallbackPaths).toContain("/_next/webpack-hmr");
  });
});

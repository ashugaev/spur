import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpGateway } from "./mcp-gateway.js";
import { createMcpWrapper } from "./mcp.js";
import { getBuildId } from "./build-identity.js";
import { readMcpTunnelStatus } from "./mcp-tunnel.js";

export interface McpProbeResult {
  ok: boolean;
  buildId?: string;
  daemonBuildId?: string;
  pid?: number;
  daemonPid?: number;
  configPath?: string;
  error?: string;
}

export async function probeMcpServer(options: {
  url: string;
  expectedBuildId?: string;
  expectedConfigPath?: string;
  timeoutMs?: number;
}): Promise<McpProbeResult> {
  const client = new Client({ name: "spur-health", version: "1" });
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5000);
  let responseId: string | undefined;
  let outcome: McpProbeResult | undefined;
  try {
    // SDK HTTP transport declarations do not support exactOptionalPropertyTypes.
    await client.connect(
      new StreamableHTTPClientTransport(new URL(options.url)) as unknown as Transport,
      { signal },
    );
    const projects = await client.callTool({ name: "list_projects", arguments: {} }, undefined, {
      signal,
    });
    const content = projects.structuredContent as Record<string, unknown> | undefined;
    if (typeof content?.responseId === "string") responseId = content.responseId;
    if (projects.isError) throw new Error("MCP list_projects failed");
    const result = await client.callTool({ name: "mcp_status", arguments: {} }, undefined, {
      signal,
    });
    const status = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError || !status || status.ok !== true) throw new Error("MCP status failed");
    const daemon = status.daemon;
    if (!daemon || typeof daemon !== "object" || Array.isArray(daemon))
      throw new Error("Invalid MCP daemon identity");
    const identity = daemon as Record<string, unknown>;
    if (
      typeof status.buildId !== "string" ||
      typeof identity.buildId !== "string" ||
      status.buildId !== identity.buildId ||
      (options.expectedBuildId && status.buildId !== options.expectedBuildId)
    )
      throw new Error("MCP/daemon installed build mismatch");
    if (
      typeof status.configPath !== "string" ||
      identity.configPath !== status.configPath ||
      (options.expectedConfigPath && status.configPath !== options.expectedConfigPath)
    )
      throw new Error("MCP/daemon config mismatch");
    if (typeof status.pid !== "number" || typeof identity.pid !== "number")
      throw new Error("Missing MCP/daemon process identity");
    outcome = {
      ok: true,
      buildId: status.buildId,
      daemonBuildId: identity.buildId,
      pid: status.pid,
      daemonPid: identity.pid,
      configPath: status.configPath,
    };
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : "MCP probe failed" };
  } finally {
    let cleanupFailed = false;
    try {
      if (responseId) {
        const released = await client.callTool(
          { name: "release_response", arguments: { responseId } },
          undefined,
          { signal: AbortSignal.timeout(1000), timeout: 1000 },
        );
        const content = released.structuredContent as Record<string, unknown> | undefined;
        cleanupFailed = released.isError === true || typeof content?.released !== "boolean";
      }
    } catch {
      cleanupFailed = true;
    } finally {
      await client.close().catch(() => undefined);
    }
    if (cleanupFailed)
      outcome = {
        ok: false,
        error: outcome?.error
          ? `${outcome.error}; MCP response cleanup failed`
          : "MCP response cleanup failed",
      };
  }
  return outcome;
}

export async function startMcpHttp(
  configPath?: string,
): Promise<{ server: Server; gateway: McpGateway; close: () => Promise<void> }> {
  const gateway = await McpGateway.create(configPath);
  const port = gateway.config.config.mcp.port;
  const wrappers = new Set<ReturnType<typeof createMcpWrapper>>();
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const allowedOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    if (
      !allowedHosts.includes(request.headers.host ?? "") ||
      (request.headers.origin !== undefined && !allowedOrigins.includes(request.headers.origin))
    ) {
      response.writeHead(403).end("Unexpected Host or Origin");
      return;
    }
    if (request.url === "/healthz" && request.method === "GET") {
      try {
        const daemon = await gateway.info(
          AbortSignal.any([gateway.lifetime.signal, AbortSignal.timeout(5000)]),
        );
        const tunnel = await readMcpTunnelStatus(gateway.config.config.dataDir);
        const ok = daemon.buildId === getBuildId() && tunnel.ready;
        response
          .writeHead(ok ? 200 : 503, { "content-type": "application/json" })
          .end(JSON.stringify({ ok, buildId: getBuildId(), pid: process.pid, daemon, tunnel }));
      } catch (error) {
        response.writeHead(503, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : "Daemon unavailable",
          }),
        );
      }
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const wrapper = createMcpWrapper(gateway);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins,
    });
    wrappers.add(wrapper);
    response.once("close", () => {
      wrappers.delete(wrapper);
      void wrapper.close();
    });
    try {
      let parsed: unknown;
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk as Uint8Array);
          size += buffer.length;
          if (size > 256 * 1024) {
            response.writeHead(413).end("MCP body exceeds 262144 bytes");
            return;
          }
          chunks.push(buffer);
        }
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch {
          response.writeHead(400).end("Invalid JSON");
          return;
        }
      }
      await wrapper.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, parsed);
    } catch {
      if (!response.headersSent) response.writeHead(500).end("MCP transport failed");
      else response.end();
    }
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await gateway.close();
    throw error;
  }
  return {
    server,
    gateway,
    close: async () => {
      gateway.lifetime.abort();
      await Promise.allSettled([...wrappers].map((wrapper) => wrapper.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await gateway.close();
    },
  };
}

export async function runMcpHttp(configPath?: string): Promise<void> {
  const host = await startMcpHttp(configPath);
  const close = () => {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    void host.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

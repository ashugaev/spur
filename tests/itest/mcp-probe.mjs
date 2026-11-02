// Probe the installed service with its own SDK; never spawn a substitute server.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";
import process from "node:process";
const { fetch, AbortSignal } = globalThis;

export async function probe({ packageRoot, url, expectedBuild }) {
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/mcp"
  )
    throw new Error("probe requires an itest loopback /mcp endpoint");
  if (!/^[a-f0-9]{64}$/.test(expectedBuild))
    throw new Error("expected runtime build identity required");
  const { computeBuildId } = await import(
    pathToFileURL(resolve(packageRoot, "dist/build-identity.js")).href
  );
  if (computeBuildId(resolve(packageRoot, "dist")) !== expectedBuild)
    throw new Error("installed runtime payload differs from candidate");
  const installedRequire = createRequire(resolve(packageRoot, "package.json"));
  const { Client } = await import(
    pathToFileURL(installedRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href
  );
  const { StreamableHTTPClientTransport } = await import(
    pathToFileURL(installedRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))
      .href
  );
  const client = new Client({ name: "spur-itest", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint), { timeout: 30_000 });
    const tools = await client.listTools();
    for (const name of ["list_projects", "mcp_status", "daemon_request", "describe_operations"]) {
      if (!tools.tools.some((tool) => tool.name === name))
        throw new Error(`installed service missing ${name}`);
    }
    const projects = await client.callTool({ name: "list_projects", arguments: {} });
    if (projects.isError) throw new Error("installed list_projects failed");
    const status = await client.callTool({ name: "mcp_status", arguments: {} });
    if (status.isError) throw new Error("installed mcp_status failed");
    const healthResponse = await fetch(new URL("/healthz", endpoint), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!healthResponse.ok) throw new Error(`MCP health failed: ${healthResponse.status}`);
    const health = await healthResponse.json();
    if (health.buildId !== expectedBuild || health.daemon?.buildId !== expectedBuild)
      throw new Error("installed MCP build identity differs from candidate");
    if (
      status.structuredContent?.buildId !== expectedBuild ||
      status.structuredContent?.daemon?.buildId !== expectedBuild
    )
      throw new Error("MCP protocol build identity differs from candidate");
    return { initialized: true, listProjects: true, status, health };
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const read = (flag) => args[args.indexOf(flag) + 1];
  if (
    !["--package-root", "--url", "--expected-build"].every(
      (flag) => args.includes(flag) && read(flag),
    )
  )
    throw new Error(
      "usage: mcp-probe.mjs --package-root <installed-package> --url <loopback-mcp-url> --expected-build <sha256>",
    );
  process.stdout.write(
    `${JSON.stringify(await probe({ packageRoot: read("--package-root"), url: read("--url"), expectedBuild: read("--expected-build") }))}\n`,
  );
}

#!/usr/bin/env node
import { publishIsolatedWebEndpoint } from "../dist/isolated-web-endpoint.js";

const [configPath, filePath, port, pid] = globalThis.process.argv.slice(2);
try {
  await publishIsolatedWebEndpoint({ configPath, filePath, port: Number(port), pid: Number(pid) });
} catch {
  globalThis.process.stderr.write("Cannot publish isolated UI endpoint\n");
  globalThis.process.exitCode = 1;
}

#!/usr/bin/env node
import {
  captureIsolatedDaemonStarttime,
  publishIsolatedWebEndpoint,
  validateIsolatedDaemonReady,
} from "../dist/isolated-web-endpoint.js";

const args = globalThis.process.argv.slice(2);
try {
  if (args[0] === "--owner-starttime") {
    const starttime = await captureIsolatedDaemonStarttime(Number(args[1]));
    if (starttime === null) throw new Error("Unavailable owner");
    globalThis.process.stdout.write(`${starttime}\n`);
  } else if (args[0] === "--daemon-ready") {
    const [
      ,
      configPath,
      filePath,
      dataDir,
      baseUrl,
      socketName,
      pid,
      starttime,
      expectedLifecycleInstanceId,
    ] = args;
    if (!pid || !starttime) throw new Error("Missing daemon owner");
    const lifecycle = await validateIsolatedDaemonReady(
      {
        configPath,
        filePath,
        dataDir,
        baseUrl,
        socketName,
        pid: Number(pid),
        starttime: Number(starttime),
      },
      expectedLifecycleInstanceId,
    );
    if (lifecycle === null) throw new Error("Daemon not ready");
    globalThis.process.stdout.write(`${lifecycle}\n`);
  } else {
    const [configPath, filePath, port, pid] = args;
    await publishIsolatedWebEndpoint({
      configPath,
      filePath,
      port: Number(port),
      pid: Number(pid),
    });
  }
} catch {
  globalThis.process.stderr.write("Cannot validate or publish isolated runtime\n");
  globalThis.process.exitCode = 1;
}

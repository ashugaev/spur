const configPath = process.argv[2];
if (!configPath || !process.env.HOME || process.env.SPUR_DISABLE_AUTOSTART !== "1")
  throw new Error("Owned daemon isolation required");
process.send?.({ startupStage: "importing-server", pid: process.pid });
const { startServer } = await import("../../src/server.js");
process.send?.({ startupStage: "starting-server", pid: process.pid });
const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
process.send?.({ ready: true, pid: process.pid, info: server.info() });

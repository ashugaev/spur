export {};

const configPath = process.argv[2];
if (!configPath || !process.env.HOME || process.env.SPUR_DISABLE_AUTOSTART !== "1")
  throw new Error("Owned daemon isolation required");
process.send?.({ stage: "bootstrap" });
const { startServer } = await import("../../src/server.js");
process.send?.({ stage: "imports-complete" });
const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
process.send?.({ stage: "ready", ready: true, pid: process.pid, info: server.info() });

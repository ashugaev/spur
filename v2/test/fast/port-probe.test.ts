import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isHostPortFree } from "../../src/port-probe.js";

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("isHostPortFree", () => {
  it("returns true when no process is bound to the port", async () => {
    // Grab an ephemeral port, release it, then probe it.
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "0.0.0.0", () => {
        const addr = probe.address();
        if (typeof addr === "object" && addr) resolve(addr.port);
        else reject(new Error("no address"));
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    expect(await isHostPortFree(port)).toBe(true);
  });

  it("returns false when the host already has a listener on the port", async () => {
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "0.0.0.0", () => {
        const addr = probe.address();
        if (typeof addr === "object" && addr) resolve(addr.port);
        else reject(new Error("no address"));
      });
    });
    openServers.push(probe);
    expect(await isHostPortFree(port)).toBe(false);
  });
});

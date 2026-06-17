import { createServer } from "node:net";

export function isHostPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    let settled = false;
    const settle = (free: boolean) => {
      if (settled) return;
      settled = true;
      resolve(free);
    };
    server.once("error", () => settle(false));
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      server.close(() => settle(true));
    });
  });
}

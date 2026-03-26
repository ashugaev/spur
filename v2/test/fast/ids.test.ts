import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "../helpers/common.js";

const randomBytesMock = vi.fn();
const tempDirs: string[] = [];

vi.mock("node:crypto", () => ({
  randomBytes: randomBytesMock,
}));

afterEach(async () => {
  randomBytesMock.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("reserveNextSessionId", () => {
  it("returns ids in the <prefix>-<hash4> format", async () => {
    const rootDir = await createTempDir("spur-ids-fast-");
    tempDirs.push(rootDir);
    randomBytesMock.mockReturnValue(Buffer.from("a1b2", "hex"));

    const { reserveNextSessionId } = await import("../../src/ids.js");
    const sessionId = await reserveNextSessionId(rootDir, "api", "api");

    expect(sessionId).toBe("api-a1b2");
  });

  it("retries when the generated hash collides with an existing session id", async () => {
    const rootDir = await createTempDir("spur-ids-collision-");
    tempDirs.push(rootDir);
    await mkdir(join(rootDir, "sessions", "api"), { recursive: true });
    await writeFile(join(rootDir, "sessions", "api", "api-a1b2.json"), "{}\n", "utf8");
    randomBytesMock
      .mockReturnValueOnce(Buffer.from("a1b2", "hex"))
      .mockReturnValueOnce(Buffer.from("c3d4", "hex"));

    const { reserveNextSessionId } = await import("../../src/ids.js");
    const sessionId = await reserveNextSessionId(rootDir, "api", "api");

    expect(sessionId).toBe("api-c3d4");
  });
});

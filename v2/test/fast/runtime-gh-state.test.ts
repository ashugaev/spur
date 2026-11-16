import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createRuntimeTestContext, type FakeGhState } from "../helpers/runtime.js";

it("publishes complete GitHub fixture states to concurrent external readers", async () => {
  const context = await createRuntimeTestContext(0, { useFakeTools: false });
  const states: FakeGhState[] = Array.from({ length: 17 }, (_, number) => ({
    searchPrs: [
      {
        number,
        title: "x".repeat(1024 * 1024),
        url: `https://github.com/acme/api/pull/${number}`,
        repository: { nameWithOwner: "acme/api" },
      },
    ],
  }));
  const contents = states.map((state) => `${JSON.stringify(state, null, 2)}\n`);
  const digests = contents.map((text) => createHash("sha256").update(text).digest("hex"));
  let reader: ReturnType<typeof spawn> | undefined;
  try {
    await context.writeGhState(states[0]);
    reader = spawn(
      process.execPath,
      [
        "-e",
        `
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const valid = new Set(process.argv.slice(2));
const initial = process.argv[2];
let reads = 0;
let changedReads = 0;
const errors = [];
function read() {
  try {
    const text = readFileSync(process.argv[1], "utf8");
    JSON.parse(text);
    const digest = createHash("sha256").update(text).digest("hex");
    if (!valid.has(digest)) throw new Error("Unpublished state observed");
    reads += 1;
    if (digest !== initial) changedReads += 1;
  } catch (error) {
    errors.push(String(error));
  }
}
function loop() {
  read();
  setImmediate(loop);
}
read();
process.send("ready");
process.on("message", () => {
  process.send({ reads, changedReads, errors }, () => process.exit(0));
});
setImmediate(loop);
`,
        context.ghStateFile,
        ...digests,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const exited = once(reader, "exit");
    expect((await once(reader, "message"))[0]).toBe("ready");
    for (const state of states.slice(1)) await context.writeGhState(state);
    const result = once(reader, "message");
    reader.send("stop");
    const [observation]: unknown[] = await result;
    await exited;
    expect(observation).toEqual({
      reads: expect.any(Number),
      changedReads: expect.any(Number),
      errors: [],
    });
    if (
      typeof observation !== "object" ||
      observation === null ||
      !("reads" in observation) ||
      !("changedReads" in observation)
    )
      throw new Error("Invalid reader observation");
    expect(observation.reads).toBeGreaterThan(1);
    expect(observation.changedReads).toBeGreaterThan(0);
    expect(await readFile(context.ghStateFile, "utf8")).toBe(contents.at(-1));
  } finally {
    if (reader && reader.exitCode === null && reader.signalCode === null) {
      const exited = once(reader, "exit");
      reader.kill("SIGTERM");
      await exited;
    }
    await context.cleanup();
  }
});

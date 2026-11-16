import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as FileSystem from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createRuntimeTestContext, type FakeGhState } from "../helpers/runtime.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FileSystem>();
  return { ...original, writeFile: vi.fn(original.writeFile) };
});

it("publishes complete GitHub fixture states to concurrent external readers", async () => {
  const context = await createRuntimeTestContext(0, { useFakeTools: false });
  const createState = (number: number): FakeGhState => ({
    searchPrs: [
      {
        number,
        title: "x".repeat(1024 * 1024),
        url: `https://github.com/acme/api/pull/${number}`,
        repository: { nameWithOwner: "acme/api" },
      },
    ],
  });
  const initialState = createState(0);
  const finalState = createState(16);
  const states = [
    initialState,
    ...Array.from({ length: 15 }, (_, index) => createState(index + 1)),
    finalState,
  ];
  const contents = states.map((state) => `${JSON.stringify(state, null, 2)}\n`);
  const digests = contents.map((text) => createHash("sha256").update(text).digest("hex"));
  let reader: ReturnType<typeof spawn> | undefined;
  try {
    await context.writeGhState(initialState);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const valid = new Set(process.argv.slice(2));
const initial = process.argv[2];
const final = process.argv.at(-1);
let reads = 0;
let changedReads = 0;
let intermediateReads = 0;
let errors = 0;
function read() {
  try {
    const text = readFileSync(process.argv[1], "utf8");
    JSON.parse(text);
    const digest = createHash("sha256").update(text).digest("hex");
    if (!valid.has(digest)) throw new Error("Unpublished state observed");
    reads += 1;
    if (digest !== initial) changedReads += 1;
    if (digest !== initial && digest !== final) intermediateReads += 1;
  } catch {
    errors += 1;
  }
}
function loop() {
  read();
  setImmediate(loop);
}
read();
process.send("ready");
process.on("message", (message) => {
  if (message === "checkpoint") {
    read();
    process.send("checkpoint");
    return;
  }
  process.send({ reads, changedReads, intermediateReads, errors }, () => process.exit(0));
});
setImmediate(loop);
`,
        context.ghStateFile,
        ...digests,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    reader = child;
    const exited = once(child, "exit");
    expect((await once(child, "message"))[0]).toBe("ready");
    const checkpoint = async () => {
      const response = once(child, "message");
      child.send("checkpoint");
      expect((await response)[0]).toBe("checkpoint");
    };
    const { writeFile } = await vi.importActual<typeof FileSystem>("node:fs/promises");
    vi.spyOn(FileSystem, "writeFile").mockImplementation(async (file, data, options) => {
      if (file === context.ghStateFile) {
        // Hold an in-place writer after truncation until the external reader observes it.
        await writeFile(file, "", options);
        await checkpoint();
      }
      await writeFile(file, data, options);
    });
    for (const state of states.slice(1, -1)) await context.writeGhState(state);
    await checkpoint();
    await context.writeGhState(finalState);
    const result = once(child, "message");
    child.send("stop");
    const [observation]: unknown[] = await result;
    await exited;
    expect(observation).toEqual({
      reads: expect.any(Number),
      changedReads: expect.any(Number),
      intermediateReads: expect.any(Number),
      errors: 0,
    });
    if (
      typeof observation !== "object" ||
      observation === null ||
      !("reads" in observation) ||
      !("changedReads" in observation) ||
      !("intermediateReads" in observation)
    )
      throw new Error("Invalid reader observation");
    expect(observation.reads).toBeGreaterThan(1);
    expect(observation.changedReads).toBeGreaterThan(0);
    expect(observation.intermediateReads).toBeGreaterThan(0);
    expect(await FileSystem.readFile(context.ghStateFile, "utf8")).toBe(contents.at(-1));
  } finally {
    vi.restoreAllMocks();
    if (reader && reader.exitCode === null && reader.signalCode === null) {
      const exited = once(reader, "exit");
      reader.kill("SIGTERM");
      await exited;
    }
    await context.cleanup();
  }
});

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { claimContinuation, type ClaimProbes } from "../../src/release-continuation-state.js";
import { createTempDir } from "../helpers/common.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const path = await createTempDir("release-claims-");
  roots.push(path);
  return path;
}
const live: ClaimProbes = {
  boot: async () => "boot",
  process: async () => ({ kind: "ok", starttime: 12, state: "R" }),
};
test("live owner and unknown process never expire into takeover", async () => {
  const path = await root();
  const first = await claimContinuation(path, live);
  await expect(claimContinuation(path, live)).rejects.toThrow("owner-live");
  let reads = 0;
  await expect(
    claimContinuation(path, {
      ...live,
      process: async () =>
        ++reads === 1 ? { kind: "ok", starttime: 12, state: "R" } : { kind: "unknown" },
    }),
  ).rejects.toThrow("identity-unknown");
  await first.retire();
  const next = await claimContinuation(path, live);
  expect(next.generation).toBe(2);
  await expect(first.assertCurrent()).rejects.toThrow("fenced");
  await expect(first.retire()).rejects.toThrow("fenced");
  await next.assertCurrent();
});
test.each(["gone", "reuse", "reboot", "zombie"])(
  "confirmed %s permits immutable successor",
  async (mode) => {
    const path = await root();
    await claimContinuation(path, live);
    let reads = 0;
    const next = await claimContinuation(path, {
      boot: async () => (mode === "reboot" ? "next-boot" : "boot"),
      process: async () => {
        if (++reads === 1) return { kind: "ok", starttime: 99, state: "R" };
        if (mode === "gone") return { kind: "gone" };
        return {
          kind: "ok",
          starttime: mode === "reuse" ? 99 : 12,
          state: mode === "zombie" ? "Z" : "R",
        };
      },
    });
    expect(next.generation).toBe(2);
    expect(JSON.parse(await readFile(join(path, "1.claim"), "utf8"))).toMatchObject({
      generation: 1,
      starttime: 12,
    });
  },
);
test("staging debris is ignored; published corruption blocks", async () => {
  const path = await root();
  await writeFile(join(path, "dead.stage"), "");
  await claimContinuation(path, live);
  await writeFile(join(path, "1.claim"), "");
  await expect(claimContinuation(path, live)).rejects.toThrow("claim-invalid");
});
test("simultaneous same-generation successors publish one complete holder", async () => {
  const path = await root();
  await mkdir(join(path, "unused"));
  const outcomes = await Promise.allSettled([
    claimContinuation(path, live),
    claimContinuation(path, live),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  const claim: unknown = JSON.parse(await readFile(join(path, "1.claim"), "utf8"));
  expect(claim).toMatchObject({
    generation: 1,
    predecessor: null,
    boot: "boot",
    pid: process.pid,
    starttime: 12,
  });
});

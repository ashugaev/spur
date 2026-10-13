import { Command } from "commander";
import { expect, test, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReviewApp } from "../../src/review-app.js";
import { createProgram } from "../../src/cli.js";

const faults = vi.hoisted(() => ({ pattern: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (faults.pattern && typeof args[1] === "string" && args[1].includes(faults.pattern)) {
        faults.pattern = "";
        throw new Error("fixture first save failed");
      }
      return actual.writeFile(...args);
    },
  };
});

test("registers daemon-free required status and publish inputs", () => {
  const program = new Command();
  registerReviewApp(program);
  const command = program.commands[0];
  if (!command) throw new Error("missing review-app command");
  expect(command.name()).toBe("review-app");
  expect(command.commands.map((child) => child.name())).toEqual([
    "prepare",
    "block",
    "status",
    "publish",
  ]);
  for (const child of command.commands)
    expect(child.options.find((option) => option.long === "--app-config")?.mandatory).toBe(true);
});

test.each(["prepare", "block"])(
  "failed %s receipt registration exits nonzero after BLOCKED persistence",
  async (action) => {
    const dir = await mkdtemp(join(tmpdir(), "spur-cli-receipt-"));
    const previousExit = process.exitCode,
      previousSession = process.env["SPUR_SESSION"];
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      process.env["SPUR_SESSION"] = "fixture-session";
      const config = join(dir, "config.json"),
        request = join(dir, "request.json");
      await writeFile(
        config,
        JSON.stringify({
          repositories: ["fixture/repo"],
          receiptRoot: dir,
          code: { appId: 1, keyPath: "/missing" },
          browser: { appId: 2, keyPath: "/missing" },
        }),
      );
      await writeFile(
        request,
        JSON.stringify({
          repo: "fixture/repo",
          pr: 1,
          lane: "code",
          session: "fixture-session",
          attempt: "fixture-attempt",
          H: "a".repeat(40),
          B: "b".repeat(40),
          contractDigest: "c".repeat(64),
          receipt: join(dir, "fixture", "repo", "1", "code.json"),
        }),
      );
      const run = (name: string) =>
        createProgram("/tmp/dist/cli.js").parseAsync([
          "node",
          "spur",
          "review-app",
          name,
          "--app-config",
          config,
          "--request",
          request,
          "--json",
        ]);
      if (action === "block") await run("prepare");
      faults.pattern = action === "prepare" ? '"status": "PENDING"' : '"reason": "review-blocked"';
      process.exitCode = undefined;
      await run(action);
      expect(process.exitCode).toBe(1);
    } finally {
      faults.pattern = "";
      output.mockRestore();
      process.exitCode = previousExit;
      if (previousSession === undefined) delete process.env["SPUR_SESSION"];
      else process.env["SPUR_SESSION"] = previousSession;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("real CLI rejects invalid config without daemon initialization", async () => {
  const program = createProgram("/tmp/dist/cli.js");
  await expect(
    program.parseAsync([
      "node",
      "spur",
      "review-app",
      "status",
      "--app-config",
      "/nonexistent-review-app-config",
      "--repo",
      "owner/repo",
      "--json",
    ]),
  ).rejects.toThrow("review-app: invalid-json-file");
});

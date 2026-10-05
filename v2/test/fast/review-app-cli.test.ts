import { Command } from "commander";
import { expect, test } from "vitest";
import { registerReviewApp } from "../../src/review-app.js";
import { createProgram } from "../../src/cli.js";

test("registers daemon-free required status and publish inputs", () => {
  const program = new Command();
  registerReviewApp(program);
  const command = program.commands[0];
  if (!command) throw new Error("missing review-app command");
  expect(command.name()).toBe("review-app");
  expect(command.commands.map((child) => child.name())).toEqual(["status", "publish"]);
  for (const child of command.commands)
    expect(child.options.find((option) => option.long === "--app-config")?.mandatory).toBe(true);
});

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

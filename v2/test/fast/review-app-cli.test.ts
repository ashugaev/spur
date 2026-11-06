import { Command } from "commander";
import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, test, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReviewApp } from "../../src/review-app.js";
import { createProgram } from "../../src/cli.js";
import { createReviewAppProgram, run as runReviewApp } from "../../src/review-app-cli.js";
import { plan, capability } from "./review-feedback.fixture.js";
import { object, readJson } from "../../src/github-app.js";

const faults = vi.hoisted(() => ({ pattern: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (faults.pattern && (typeof args[1] === "string" || Buffer.isBuffer(args[1])) && args[1].toString().includes(faults.pattern)) {
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
    "recover",
    "status",
    "publish",
  ]);
  for (const child of command.commands)
    expect(child.options.find((option) => option.long === "--app-config")?.mandatory).toBe(true);
  const recover = command.commands.find((child) => child.name() === "recover");
  expect(recover?.options.find((option) => option.long === "--request")?.mandatory).toBe(true);
  expect(recover?.options.find((option) => option.long === "--legacy-sha256")?.mandatory).toBe(
    true,
  );
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
          feedback: plan,
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
      if (action === "block") {
        await run("prepare");
        const input = object(await readJson(request));
        await writeFile(request, JSON.stringify({ ...input, feedback: capability }));
      }
      faults.pattern = action === "prepare" ? '"status": "PENDING"' : '"reason": "review-blocked"';
      process.exitCode = undefined;
      await run(action);
      expect(process.exitCode).toBe(1);
      expect(output.mock.calls.at(-1)?.[0]).toContain('"feedbackPublication":{"status":"failed"');
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

test.each(["--app-config", "--request", "--legacy-sha256"])(
  "recover requires %s before daemon initialization",
  async (missing) => {
    const program = new Command().exitOverride();
    registerReviewApp(program);
    const args = ["node", "spur", "review-app", "recover"];
    for (const option of ["--app-config", "--request", "--legacy-sha256"])
      if (option !== missing) args.push(option, "fixture");
    await expect(program.parseAsync(args)).rejects.toThrow(missing);
  },
);

test.each(["full", "dedicated"])("%s recover rejects invalid digest or session before network and leaves receipt untouched", async (entry) => {
  const dir = await mkdtemp(join(tmpdir(), "spur-recover-cli-"));
  const previousSession = process.env["SPUR_SESSION"];
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
  try {
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
        attempt: "fresh-attempt",
        H: "a".repeat(40),
        B: "b".repeat(40),
        contractDigest: "c".repeat(64),
        receipt: join(dir, "fixture", "repo", "1", "code.json"),
      }),
    );
    for (const session of ["fixture-session", "other-session"]) {
      process.env["SPUR_SESSION"] = session;
      const program = entry === "dedicated" ? createReviewAppProgram() : createProgram("/tmp/dist/cli.js");
      await expect(
        program.parseAsync([
          "node",
          "spur",
          "review-app",
          "recover",
          "--app-config",
          config,
          "--request",
          request,
          "--legacy-sha256",
          session === "fixture-session" ? "invalid" : "a".repeat(64),
          "--json",
        ]),
      ).rejects.toThrow(session === "fixture-session" ? "invalid-hash" : "session-mismatch");
    }
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    if (previousSession === undefined) delete process.env["SPUR_SESSION"];
    else process.env["SPUR_SESSION"] = previousSession;
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(
  ["full", "dedicated"].flatMap((entry) =>
    ["verified-pending", "announcement-failure", "write-failure", "missing-plan", "capability-plan", "malformed-plan"].map((mode) => ({ entry, mode })),
  ),
)(
  "daemon-free $entry recover CLI $mode obeys verified PENDING exit contract",
  async ({ entry, mode }) => {
    const dir = await mkdtemp(join(tmpdir(), "spur-recover-cli-result-"));
    const previousSession = process.env["SPUR_SESSION"],
      previousExit = process.exitCode;
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let comment: { id: number; body: string; user: { login: string } } | undefined;
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === "/app") return Response.json({ id: 1, slug: "code" });
      if (path.endsWith("/installation")) return Response.json({ id: 2, app_id: 1 });
      if (path.endsWith("/access_tokens"))
        return Response.json({
          token: "fixture-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: { pull_requests: "write", metadata: "read" },
        });
      if (path === "/repos/fixture/repo")
        return Response.json({ id: 3, full_name: "fixture/repo" });
      if (path.endsWith("/pulls/1"))
        return Response.json({
          state: "open",
          head: { sha: "a".repeat(40) },
          base: { sha: "b".repeat(40) },
        });
      if (path.endsWith("/issues/1/comments")) {
        if (options?.method !== "POST") return Response.json([]);
        let payload: { body: string };
        try {
          payload = JSON.parse(String(options.body)) as { body: string };
        } catch (error) {
          throw new Error("Invalid CLI fixture comment payload", { cause: error });
        }
        comment = { id: 1, body: payload.body, user: { login: "code[bot]" } };
        return Response.json(comment);
      }
      if (path.endsWith("/issues/comments/1"))
        return Response.json(mode === "announcement-failure" ? {} : comment);
      throw new Error(`unexpected fixture endpoint ${path}`);
    });
    try {
      const keyPath = join(dir, "key.pem");
      await writeFile(
        keyPath,
        generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
        { mode: 0o600 },
      );
      const config = join(dir, "config.json"),
        request = join(dir, "request.json");
      const receipt = join(dir, "fixture", "repo", "1", "code.json");
      await mkdir(join(dir, "fixture", "repo", "1"), { recursive: true });
      const raw = Buffer.from(
        JSON.stringify({
          repository: "fixture/repo",
          pr: 1,
          lane: "code",
          session: "old-session",
          attempt: "old-attempt",
          previousAttempt: "older-attempt",
          H: "a".repeat(40),
          B: "b".repeat(40),
          contractDigest: "c".repeat(64),
          status: "BLOCKED",
          localVerdict: "FAIL",
          publicationVerdict: "BLOCKED",
          reviewId: null,
          evidence: [],
        }),
      );
      await writeFile(receipt, raw);
      await writeFile(
        config,
        JSON.stringify({
          repositories: ["fixture/repo"],
          receiptRoot: dir,
          code: { appId: 1, keyPath },
          browser: { appId: 2, keyPath },
        }),
      );
      await writeFile(
        request,
        JSON.stringify({
          repo: "fixture/repo",
          pr: 1,
          lane: "code",
          session: "fixture-session",
          attempt: "fresh-attempt",
          H: "a".repeat(40),
          B: "b".repeat(40),
          contractDigest: "c".repeat(64),
          receipt,
          feedback: mode === "missing-plan" ? undefined : mode === "capability-plan" ? capability : mode === "malformed-plan" ? {} : plan,
        }),
      );
      process.env["SPUR_SESSION"] = "fixture-session";
      process.exitCode = undefined;
      if (mode === "write-failure") faults.pattern = '"status": "PENDING"';
      const program = entry === "dedicated" ? createReviewAppProgram() : createProgram("/tmp/dist/cli.js");
      const run = program.parseAsync([
        "node",
        "spur",
        "review-app",
        "recover",
        "--app-config",
        config,
        "--request",
        request,
        "--legacy-sha256",
        createHash("sha256").update(raw).digest("hex"),
        "--json",
      ]);
      if (mode.endsWith("-plan")) {
        await expect(run).rejects.toThrow(mode === "missing-plan" ? "invalid-response" : "invalid-review-feedback");
        expect(network).not.toHaveBeenCalled();
        expect(await readFile(receipt)).toEqual(raw);
      } else if (mode === "write-failure") await expect(run).rejects.toThrow("receipt-write");
      else {
        await run;
        expect(output.mock.calls.at(-1)?.[0]).toContain(
          `"status":"${mode === "verified-pending" ? "PENDING" : "BLOCKED"}"`,
        );
        expect(process.exitCode).toBe(mode === "verified-pending" ? undefined : 1);
        expect(output.mock.calls.at(-1)?.[0]).toContain(
          `"feedbackPublication":{"status":"${mode === "verified-pending" ? "confirmed" : "failed"}"`,
        );
      }
      expect(network.mock.calls.some(([url]) => String(url).includes("/reviews"))).toBe(false);
    } finally {
      faults.pattern = "";
      output.mockRestore();
      network.mockRestore();
      process.exitCode = previousExit;
      if (previousSession === undefined) delete process.env["SPUR_SESSION"];
      else process.env["SPUR_SESSION"] = previousSession;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("dedicated import/program construction registers only inert review handlers", () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
  try {
    const program = createReviewAppProgram();
    expect(program.commands.map((command) => command.name())).toEqual(["review-app"]);
    expect(program.commands[0]?.commands.map((command) => command.name())).toEqual([
      "prepare", "block", "recover", "status", "publish",
    ]);
    const inspect = (command: Command) => {
      expect((command as Command & { _executableHandler?: boolean })._executableHandler).not.toBe(true);
      command.commands.forEach(inspect);
    };
    inspect(program);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});

test.each([
  ["daemon", "--help"], ["--help", "daemon"], ["review-gate", "--help"],
  ["review-app", "daemon", "--help"], ["--config", "fixture", "--help"],
  ["--version"], ["spawn", "--json"],
].map((args) => ({ args })))("dedicated run refuses unrelated argv $args before help or actions", async ({ args }) => {
  const previous = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
  try {
    process.exitCode = undefined;
    await runReviewApp(["node", "review-app-cli.js", ...args]);
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    process.exitCode = previous;
    stdout.mockRestore();
    stderr.mockRestore();
    network.mockRestore();
  }
});

test("dedicated help preserves required-option discovery and generic error exits", async () => {
  const previous = process.exitCode;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
  try {
    process.exitCode = undefined;
    await runReviewApp(["node", "review-app-cli.js", "review-app", "recover", "--help"]);
    expect(process.exitCode).toBe(0);
    expect(stdout.mock.calls.map(([text]) => String(text)).join("")).toContain("--legacy-sha256");
    process.exitCode = undefined;
    await runReviewApp(["node", "review-app-cli.js", "review-app", "status", "--app-config", "/nonexistent-fixture-config", "--repo", "fixture/repo"]);
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("invalid-json-file");
    expect(network).not.toHaveBeenCalled();
  } finally {
    process.exitCode = previous;
    stdout.mockRestore();
    stderr.mockRestore();
    network.mockRestore();
  }
});

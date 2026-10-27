import { Command } from "commander";
import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, test, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
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

test("recover rejects invalid digest or session before network and leaves receipt untouched", async () => {
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
      await expect(
        createProgram("/tmp/dist/cli.js").parseAsync([
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

test.each(["verified-pending", "announcement-failure", "write-failure"])(
  "daemon-free recover CLI %s obeys verified PENDING exit contract",
  async (mode) => {
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
        const payload = JSON.parse(String(options.body)) as { body: string };
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
        }),
      );
      process.env["SPUR_SESSION"] = "fixture-session";
      process.exitCode = undefined;
      if (mode === "write-failure") faults.pattern = '"status": "PENDING"';
      const run = createProgram("/tmp/dist/cli.js").parseAsync([
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
      if (mode === "write-failure") await expect(run).rejects.toThrow("receipt-write");
      else {
        await run;
        expect(output.mock.calls.at(-1)?.[0]).toContain(
          `"status":"${mode === "verified-pending" ? "PENDING" : "BLOCKED"}"`,
        );
        expect(process.exitCode).toBe(mode === "verified-pending" ? undefined : 1);
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

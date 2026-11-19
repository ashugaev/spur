import { Command } from "commander";
import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, test, vi, type TestContext } from "vitest";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReviewApp } from "../../src/review-app.js";
import { createProgram } from "../../src/cli.js";
import { createReviewAppProgram, run as runReviewApp } from "../../src/review-app-cli.js";
import { plan, capability } from "./review-feedback.fixture.js";
import { object, readJson } from "../../src/github-app.js";

const faults = vi.hoisted(() => ({
  pattern: "",
  readGate: undefined as { path: string; entered(): void; wait: Promise<void> } | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const gate = faults.readGate;
      if (gate && args[0] === gate.path) {
        gate.entered();
        await gate.wait;
      }
      return actual.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (
        faults.pattern &&
        (typeof args[1] === "string" || Buffer.isBuffer(args[1])) &&
        args[1].toString().includes(faults.pattern)
      ) {
        faults.pattern = "";
        throw new Error("fixture first save failed");
      }
      return actual.writeFile(...args);
    },
  };
});

type CliCaseContext = Pick<TestContext, "signal" | "onTestFinished">;

function createCliCaseRunner() {
  let tail: Promise<void> = Promise.resolve();
  return (context: CliCaseContext, body: (checkpoint: () => void) => void | Promise<void>) => {
    const predecessor = tail;
    const checkpoint = () => {
      if (context.signal.aborted) throw context.signal.reason;
    };
    const raw = Promise.resolve().then(async () => {
      const cancelled = context.signal.aborted;
      const reason: unknown = context.signal.reason;
      await predecessor;
      if (cancelled) throw reason;
      checkpoint();
      await body(checkpoint);
    });
    tail = raw.then(
      () => undefined,
      () => undefined,
    );
    context.onTestFinished(async () => {
      try {
        await raw;
      } catch (error) {
        if (!context.signal.aborted || error !== context.signal.reason) throw error;
      }
    });
    return raw;
  };
}

const runCliCase = createCliCaseRunner();

async function receiptFixture(dir: string, checkpoint: () => void) {
  const config = join(dir, "config.json"),
    request = join(dir, "request.json");
  const receipt = join(dir, "fixture", "repo", "1", "code.json");
  await writeFile(
    config,
    JSON.stringify({
      repositories: ["fixture/repo"],
      receiptRoot: dir,
      code: { appId: 1, keyPath: "/missing" },
      browser: { appId: 2, keyPath: "/missing" },
    }),
  );
  checkpoint();
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
      receipt,
      feedback: plan,
    }),
  );
  checkpoint();
  return {
    config,
    request,
    receipt,
    run: (name: string) =>
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
      ]),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controlledCase(parent: TestContext) {
  const controller = new AbortController();
  const hooks: (() => Promise<void>)[] = [];
  const context: CliCaseContext = {
    signal: controller.signal,
    onTestFinished: (hook) => {
      hooks.push(async () => {
        await hook(parent);
      });
    },
  };
  return { controller, context, finish: () => Promise.all(hooks.map((hook) => hook())) };
}

test("drains cancelled prepare before the next real block receipt registration", (context) =>
  runCliCase(context, async (checkpoint) => {
    const run = createCliCaseRunner();
    const previousSession = process.env["SPUR_SESSION"];
    const previousExit = process.exitCode;
    const readEntered = deferred(),
      readRelease = deferred();
    const finallyEntered = deferred(),
      finallyRelease = deferred();
    const operations: Promise<unknown>[] = [];
    let blockDir: string | undefined;
    let blockFixture: Awaited<ReturnType<typeof receiptFixture>> | undefined;
    const order: string[] = [];
    delete process.env["SPUR_SESSION"];
    try {
      const bootstrap = controlledCase(context);
      await run(bootstrap.context, async (check) => {
        const savedSession = process.env["SPUR_SESSION"],
          savedExit = process.exitCode;
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          process.env["SPUR_SESSION"] = "fixture-session";
          blockDir = await mkdtemp(join(tmpdir(), "spur-cli-block-race-"));
          check();
          blockFixture = await receiptFixture(blockDir, check);
          check();
          await blockFixture.run("prepare");
          check();
          const input = object(await readJson(blockFixture.request));
          check();
          await writeFile(blockFixture.request, JSON.stringify({ ...input, feedback: capability }));
          check();
        } finally {
          output.mockRestore();
          process.exitCode = savedExit;
          if (savedSession === undefined) delete process.env["SPUR_SESSION"];
          else process.env["SPUR_SESSION"] = savedSession;
        }
      });
      await bootstrap.finish();
      checkpoint();
      if (!blockFixture) throw new Error("missing prepared block fixture");
      const preparedBlock = blockFixture;
      const first = controlledCase(context);
      const cancelled = new Error("fixture prepare cancelled");
      const firstRaw = run(first.context, async (check) => {
        const savedSession = process.env["SPUR_SESSION"],
          savedExit = process.exitCode;
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        let dir: string | undefined;
        try {
          process.env["SPUR_SESSION"] = "fixture-session";
          dir = await mkdtemp(join(tmpdir(), "spur-cli-prepare-race-"));
          check();
          const fixture = await receiptFixture(dir, check);
          check();
          faults.readGate = {
            path: fixture.config,
            entered: readEntered.resolve,
            wait: readRelease.promise,
          };
          await fixture.run("prepare");
          check();
        } finally {
          finallyEntered.resolve();
          await finallyRelease.promise;
          faults.readGate = undefined;
          faults.pattern = "";
          output.mockRestore();
          process.exitCode = savedExit;
          if (savedSession === undefined) delete process.env["SPUR_SESSION"];
          else process.env["SPUR_SESSION"] = savedSession;
          if (dir) await rm(dir, { recursive: true, force: true });
          order.push("first finally settled");
        }
      });
      const firstOutcome = firstRaw.catch((error: unknown) => error);
      operations.push(firstOutcome);
      await readEntered.promise;
      first.controller.abort(cancelled);
      const firstDrain = first.finish();
      operations.push(firstDrain);
      readRelease.resolve();
      await finallyEntered.promise;
      const second = controlledCase(context);
      let blockEntered = false,
        blockError: unknown,
        blockOutput = "";
      let blockExit: typeof process.exitCode;
      let persisted: Record<string, unknown> | undefined;
      const secondRaw = run(second.context, async (check) => {
        order.push("second acquired");
        const savedSession = process.env["SPUR_SESSION"],
          savedExit = process.exitCode;
        const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
          process.env["SPUR_SESSION"] = "fixture-session";
          await firstOutcome;
          check();
          faults.pattern = '"reason": "review-blocked"';
          process.exitCode = undefined;
          blockEntered = true;
          try {
            await preparedBlock.run("block");
            check();
          } catch (error) {
            blockError = error;
          }
          blockOutput = output.mock.calls.map(([text]) => String(text)).join("");
          blockExit = process.exitCode;
          persisted = object(await readJson(preparedBlock.receipt));
          check();
        } finally {
          faults.pattern = "";
          output.mockRestore();
          process.exitCode = savedExit;
          if (savedSession === undefined) delete process.env["SPUR_SESSION"];
          else process.env["SPUR_SESSION"] = savedSession;
        }
      });
      operations.push(secondRaw);
      await new Promise<void>(queueMicrotask);
      finallyRelease.resolve();
      await secondRaw;
      await firstDrain;
      await second.finish();
      checkpoint();
      process.stdout.write(
        `${JSON.stringify({ fixture: "real-block-after-cancelled-prepare", blockEntered, error: blockError instanceof Error ? blockError.message : blockError, blockOutput, blockExit })}\n`,
      );
      expect(blockError, "actual block admission outcome").toBeUndefined();
      expect(blockEntered).toBe(true);
      expect(blockOutput).toContain('"feedbackPublication":{"status":"failed"');
      expect(blockExit).toBe(1);
      expect(persisted).toMatchObject({
        status: "BLOCKED",
        reason: "receipt-write",
        feedbackPublication: { status: "failed", error: "key-unavailable" },
      });
      expect(await firstOutcome).toBe(cancelled);
      expect(order).toEqual(["first finally settled", "second acquired"]);
      expect(process.env["SPUR_SESSION"]).toBeUndefined();
    } finally {
      readRelease.resolve();
      finallyRelease.resolve();
      await Promise.allSettled(operations);
      faults.readGate = undefined;
      faults.pattern = "";
      if (blockDir) await rm(blockDir, { recursive: true, force: true });
      process.exitCode = previousExit;
      if (previousSession === undefined) delete process.env["SPUR_SESSION"];
      else process.env["SPUR_SESSION"] = previousSession;
    }
  }));

test("cancelled queued CLI cases retain raw ownership after a drain hook failure", (context) =>
  runCliCase(context, async () => {
    const run = createCliCaseRunner();
    const first = controlledCase(context),
      queued = controlledCase(context),
      alreadyCancelled = controlledCase(context);
    const entered = deferred(),
      release = deferred();
    const acquired = vi.fn();
    const owner = run(first.context, async () => {
      entered.resolve();
      await release.promise;
    });
    const ownerDrain = first.finish();
    const hookFailure = new Error("simulated completion hook timeout");
    try {
      await entered.promise;
      await expect(Promise.race([ownerDrain, Promise.reject(hookFailure)])).rejects.toBe(
        hookFailure,
      );
      alreadyCancelled.controller.abort(new Error("already cancelled"));
      const cancelledRaw = run(alreadyCancelled.context, acquired);
      const cancelledOutcome = cancelledRaw.catch((error: unknown) => error);
      const queuedRaw = run(queued.context, acquired);
      const queuedOutcome = queuedRaw.catch((error: unknown) => error);
      await new Promise<void>(queueMicrotask);
      queued.controller.abort(new Error("queued cancellation"));
      await new Promise<void>(queueMicrotask);
      expect(acquired).not.toHaveBeenCalled();
      release.resolve();
      await owner;
      expect(await cancelledOutcome).toBe(alreadyCancelled.controller.signal.reason);
      expect(await queuedOutcome).toBe(queued.controller.signal.reason);
      await Promise.all([ownerDrain, alreadyCancelled.finish(), queued.finish()]);
      expect(acquired).not.toHaveBeenCalled();
      const healthy = controlledCase(context);
      await run(healthy.context, acquired);
      await healthy.finish();
      expect(acquired).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await owner;
      await ownerDrain;
    }
  }));

test("CLI raw drain preserves noncancellation failures after abort", (context) =>
  runCliCase(context, async () => {
    const run = createCliCaseRunner(),
      controlled = controlledCase(context);
    const entered = deferred(),
      release = deferred();
    const failure = new Error("late assertion failure");
    const raw = run(controlled.context, async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    });
    const outcome = raw.catch((error: unknown) => error);
    await entered.promise;
    controlled.controller.abort(new Error("distinct cancellation"));
    release.resolve();
    expect(await outcome).toBe(failure);
    await expect(controlled.finish()).rejects.toBe(failure);
  }));

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

test.for(["prepare", "block"])(
  "failed %s receipt registration exits nonzero after BLOCKED persistence",
  (action, context) =>
    runCliCase(context, async (checkpoint) => {
      let dir: string | undefined;
      const previousExit = process.exitCode,
        previousSession = process.env["SPUR_SESSION"];
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        process.env["SPUR_SESSION"] = "fixture-session";
        dir = await mkdtemp(join(tmpdir(), "spur-cli-receipt-"));
        checkpoint();
        const { run, request } = await receiptFixture(dir, checkpoint);
        checkpoint();
        if (action === "block") {
          await run("prepare");
          checkpoint();
          const input = object(await readJson(request));
          checkpoint();
          await writeFile(request, JSON.stringify({ ...input, feedback: capability }));
          checkpoint();
        }
        faults.pattern =
          action === "prepare" ? '"status": "PENDING"' : '"reason": "review-blocked"';
        process.exitCode = undefined;
        await run(action);
        checkpoint();
        expect(process.exitCode).toBe(1);
        expect(output.mock.calls.at(-1)?.[0]).toContain('"feedbackPublication":{"status":"failed"');
      } finally {
        faults.pattern = "";
        output.mockRestore();
        process.exitCode = previousExit;
        if (previousSession === undefined) delete process.env["SPUR_SESSION"];
        else process.env["SPUR_SESSION"] = previousSession;
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }),
);

test("real CLI rejects invalid config without daemon initialization", (context) =>
  runCliCase(context, async (checkpoint) => {
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
    checkpoint();
  }));

test.for(["--app-config", "--request", "--legacy-sha256"])(
  "recover requires %s before daemon initialization",
  (missing, context) =>
    runCliCase(context, async (checkpoint) => {
      const program = new Command().exitOverride();
      registerReviewApp(program);
      const args = ["node", "spur", "review-app", "recover"];
      for (const option of ["--app-config", "--request", "--legacy-sha256"])
        if (option !== missing) args.push(option, "fixture");
      await expect(program.parseAsync(args)).rejects.toThrow(missing);
      checkpoint();
    }),
);

test.for(["full", "dedicated"])(
  "%s recover rejects invalid digest or session before network and leaves receipt untouched",
  (entry, context) =>
    runCliCase(context, async (checkpoint) => {
      let dir: string | undefined;
      const previousSession = process.env["SPUR_SESSION"];
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("unexpected network"));
      try {
        dir = await mkdtemp(join(tmpdir(), "spur-recover-cli-"));
        checkpoint();
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
        checkpoint();
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
        checkpoint();
        for (const session of ["fixture-session", "other-session"]) {
          process.env["SPUR_SESSION"] = session;
          const program =
            entry === "dedicated" ? createReviewAppProgram() : createProgram("/tmp/dist/cli.js");
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
          checkpoint();
        }
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
        if (previousSession === undefined) delete process.env["SPUR_SESSION"];
        else process.env["SPUR_SESSION"] = previousSession;
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }),
);

test.for(
  ["full", "dedicated"].flatMap((entry) =>
    [
      "verified-pending",
      "announcement-failure",
      "write-failure",
      "missing-plan",
      "capability-plan",
      "malformed-plan",
    ].map((mode) => ({ entry, mode })),
  ),
)(
  "daemon-free $entry recover CLI $mode obeys verified PENDING exit contract",
  ({ entry, mode }, context) =>
    runCliCase(context, async (checkpoint) => {
      let dir: string | undefined;
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
            user: { login: "human" },
          });
        if (path.endsWith("/pulls/1/reviews")) return Response.json([]);
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
        dir = await mkdtemp(join(tmpdir(), "spur-recover-cli-result-"));
        checkpoint();
        const keyPath = join(dir, "key.pem");
        await writeFile(
          keyPath,
          generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
            type: "pkcs8",
            format: "pem",
          }),
          { mode: 0o600 },
        );
        checkpoint();
        const config = join(dir, "config.json"),
          request = join(dir, "request.json");
        const receipt = join(dir, "fixture", "repo", "1", "code.json");
        await mkdir(join(dir, "fixture", "repo", "1"), { recursive: true });
        checkpoint();
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
        checkpoint();
        await writeFile(
          config,
          JSON.stringify({
            repositories: ["fixture/repo"],
            receiptRoot: dir,
            code: { appId: 1, keyPath },
            browser: { appId: 2, keyPath },
          }),
        );
        checkpoint();
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
            feedback:
              mode === "missing-plan"
                ? undefined
                : mode === "capability-plan"
                  ? capability
                  : mode === "malformed-plan"
                    ? {}
                    : plan,
          }),
        );
        checkpoint();
        process.env["SPUR_SESSION"] = "fixture-session";
        process.exitCode = undefined;
        if (mode === "write-failure") faults.pattern = '"status": "PENDING"';
        const program =
          entry === "dedicated" ? createReviewAppProgram() : createProgram("/tmp/dist/cli.js");
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
          await expect(run).rejects.toThrow(
            mode === "missing-plan" ? "invalid-response" : "invalid-review-feedback",
          );
          checkpoint();
          expect(network).not.toHaveBeenCalled();
          expect(await readFile(receipt)).toEqual(raw);
          checkpoint();
        } else if (mode === "write-failure") {
          await expect(run).rejects.toThrow("receipt-write");
          checkpoint();
        } else {
          await run;
          checkpoint();
          expect(output.mock.calls.at(-1)?.[0]).toContain(
            `"status":"${mode === "verified-pending" ? "PENDING" : "BLOCKED"}"`,
          );
          expect(process.exitCode).toBe(mode === "verified-pending" ? undefined : 1);
          expect(output.mock.calls.at(-1)?.[0]).toContain(
            `"feedbackPublication":{"status":"${mode === "verified-pending" ? "confirmed" : "failed"}"`,
          );
        }
        expect(
          network.mock.calls.some(
            ([url, options]) => String(url).includes("/reviews") && options?.method === "POST",
          ),
        ).toBe(false);
        if (!mode.endsWith("-plan"))
          expect(
            network.mock.calls.some(([url]) =>
              String(url).endsWith("/reviews?per_page=100&page=1"),
            ),
          ).toBe(true);
      } finally {
        faults.pattern = "";
        output.mockRestore();
        network.mockRestore();
        process.exitCode = previousExit;
        if (previousSession === undefined) delete process.env["SPUR_SESSION"];
        else process.env["SPUR_SESSION"] = previousSession;
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    }),
);

test("dedicated import/program construction registers only inert review handlers", (context) =>
  runCliCase(context, () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network"));
    try {
      const program = createReviewAppProgram();
      expect(program.commands.map((command) => command.name())).toEqual(["review-app"]);
      expect(program.commands[0]?.commands.map((command) => command.name())).toEqual([
        "prepare",
        "block",
        "recover",
        "status",
        "publish",
      ]);
      const inspect = (command: Command) => {
        expect((command as Command & { _executableHandler?: boolean })._executableHandler).not.toBe(
          true,
        );
        command.commands.forEach(inspect);
      };
      inspect(program);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  }));

test.for(
  [
    ["daemon", "--help"],
    ["--help", "daemon"],
    ["review-gate", "--help"],
    ["review-app", "daemon", "--help"],
    ["--config", "fixture", "--help"],
    ["--version"],
    ["spawn", "--json"],
  ].map((args) => ({ args })),
)("dedicated run refuses unrelated argv $args before help or actions", ({ args }, context) =>
  runCliCase(context, async (checkpoint) => {
    const previous = process.exitCode;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network"));
    try {
      process.exitCode = undefined;
      await runReviewApp(["node", "review-app-cli.js", ...args]);
      checkpoint();
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
  }),
);

test("dedicated help preserves required-option discovery and generic error exits", (context) =>
  runCliCase(context, async (checkpoint) => {
    const previous = process.exitCode;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network"));
    try {
      process.exitCode = undefined;
      await runReviewApp(["node", "review-app-cli.js", "review-app", "recover", "--help"]);
      checkpoint();
      expect(process.exitCode).toBe(0);
      expect(stdout.mock.calls.map(([text]) => String(text)).join("")).toContain("--legacy-sha256");
      process.exitCode = undefined;
      await runReviewApp([
        "node",
        "review-app-cli.js",
        "review-app",
        "status",
        "--app-config",
        "/nonexistent-fixture-config",
        "--repo",
        "fixture/repo",
      ]);
      checkpoint();
      expect(process.exitCode).toBe(1);
      expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain(
        "invalid-json-file",
      );
      expect(network).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previous;
      stdout.mockRestore();
      stderr.mockRestore();
      network.mockRestore();
    }
  }));

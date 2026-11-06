import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cursorDeliveryInput, isCursorDeliveryId } from "../../src/agents/cursor-submit-ack.js";
import { toCursorProjectPath } from "../../src/cursor-jsonl-state.js";
import { fakeAgentScript } from "../helpers/runtime.js";

interface FixtureRecord {
  role?: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string }> };
}

async function withFakeAgent(
  agent: "claude" | "cursor",
  signal: AbortSignal,
  run: (fixture: {
    child: ChildProcessWithoutNullStreams;
    closed: Promise<void>;
    output: () => string;
    waitForOutput: (predicate: (text: string) => boolean) => Promise<void>;
    transcript: () => Promise<FixtureRecord[]>;
  }) => Promise<void>,
) {
  const tempDir = await mkdtemp(join(tmpdir(), "fake-agent-dispatch-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stdout = "";
  let stderr = "";
  let failure: Error | undefined;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => {});
  const subscribers = new Set<() => void>();
  const notify = () => {
    for (const subscriber of subscribers) subscriber();
  };
  const fail = (cause: unknown) => {
    if (failure) return;
    failure = new Error(`Fake ${agent} failed: ${stderr}`, { cause });
    rejectFailure(failure);
    notify();
  };
  const abort = () => fail(signal.reason);
  const onStdout = (chunk: Buffer) => {
    stdout = (stdout + chunk.toString("utf8")).slice(-65_536);
    notify();
  };
  const onStderr = (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-65_536);
  };
  let closed: Promise<void> | undefined;
  try {
    const scriptPath = join(tempDir, agent);
    await writeFile(scriptPath, fakeAgentScript(agent), "utf8");
    await chmod(scriptPath, 0o755);
    child = spawn(scriptPath, [], {
      cwd: tempDir,
      env: {
        ...process.env,
        HOME: tempDir,
        CURSOR_CONFIG_DIR: join(tempDir, "cursor-config"),
        SPUR_FAKE_AGENT_LOG_DIR: tempDir,
        SPUR_SESSION: "fake-agent-dispatch-test",
        SPUR_TODO_COMMAND: "",
        SPUR_AGENT_STATE_COMMAND: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const owned = child;
    closed = new Promise<void>((resolve) => {
      owned.once("close", () => {
        resolve();
        notify();
      });
    });
    owned.on("error", fail);
    owned.stdin.on("error", fail);
    owned.stdout.on("data", onStdout);
    owned.stderr.on("data", onStderr);
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => fail(new Error("Fake agent exceeded 5s")), 5000);
    if (signal.aborted) abort();
    if (failure) throw failure;
    const waitForOutput = (predicate: (text: string) => boolean) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (failure) {
            subscribers.delete(check);
            reject(failure);
          } else if (predicate(stdout)) {
            subscribers.delete(check);
            resolve();
          } else if (owned.exitCode !== null || owned.signalCode !== null) {
            subscribers.delete(check);
            reject(new Error(`Fake agent exited before expected output: ${stderr}`));
          }
        };
        subscribers.add(check);
        check();
      });
    await Promise.race([
      run({
        child: owned,
        closed,
        output: () => stdout,
        waitForOutput,
        transcript: async () => {
          const chatId = "chat-fake-agent-dispatch-test";
          const text = await readFile(
            join(
              tempDir,
              ".cursor",
              "projects",
              toCursorProjectPath(tempDir),
              "agent-transcripts",
              chatId,
              `${chatId}.jsonl`,
            ),
            "utf8",
          );
          return text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as FixtureRecord);
        },
      }),
      failed,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (child) {
      fail(new Error("Fake fixture disposed"));
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
      child.off("error", fail);
      child.stdin.off("error", fail);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
    }
    subscribers.clear();
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("fakeAgentScript claude dispatch", () => {
  it("exits on exit-now even when the whole burst lands inside one drain window", async ({
    signal,
  }) => {
    await withFakeAgent("claude", signal, async ({ child, closed, output }) => {
      const multiLinePrompt = Array.from({ length: 20 }, (_, i) => `prompt line ${i}`).join("\n");
      child.stdin.write(`${multiLinePrompt}\nexit-now\n`);
      child.stdin.end();
      await closed;
      expect(child.exitCode).toBe(0);
      expect(output()).not.toContain("ack:");
    });
  });
});

const deliveryId = "a1111111-1111-4111-8111-111111111111";
const innerId = "b2222222-2222-4222-9222-222222222222";
const marker = `[Spur delivery: ${deliveryId}]`;
const scenarios: Array<{
  name: string;
  input: string;
  kind: "menu" | "exit" | "ack";
  ack?: string;
}> = [
  {
    name: "marked menu",
    input: cursorDeliveryInput(deliveryId, "show-waiting-menu"),
    kind: "menu",
  },
  { name: "marked exit", input: cursorDeliveryInput(deliveryId, "exit-now"), kind: "exit" },
  {
    name: "marked multiline",
    input: cursorDeliveryInput(deliveryId, "first\nsecond"),
    kind: "ack",
    ack: "first",
  },
  {
    name: "uppercase UUID",
    input: cursorDeliveryInput(deliveryId.toUpperCase(), "uppercase"),
    kind: "ack",
    ack: "uppercase",
  },
  { name: "legacy menu", input: "show-waiting-menu", kind: "menu" },
  { name: "legacy exit", input: "exit-now", kind: "exit" },
  { name: "legacy ordinary", input: "legacy", kind: "ack", ack: "legacy" },
  {
    name: "wrong version",
    input: "[Spur delivery: a1111111-1111-1111-8111-111111111111]\n\nexit-now",
    kind: "ack",
    ack: "[Spur delivery: a1111111-1111-1111-8111-111111111111]",
  },
  {
    name: "wrong variant",
    input: "[Spur delivery: a1111111-1111-4111-7111-111111111111]\n\nexit-now",
    kind: "ack",
    ack: "[Spur delivery: a1111111-1111-4111-7111-111111111111]",
  },
  { name: "missing separator", input: `${marker}\nexit-now`, kind: "ack", ack: marker },
  {
    name: "foreign header",
    input: "[Other delivery: token]\n\nexit-now",
    kind: "ack",
    ack: "[Other delivery: token]",
  },
  {
    name: "embedded marker",
    input: `before\n${cursorDeliveryInput(deliveryId, "exit-now")}`,
    kind: "ack",
    ack: "before",
  },
  {
    name: "two valid envelopes",
    input: cursorDeliveryInput(deliveryId, cursorDeliveryInput(innerId, "exit-now")),
    kind: "ack",
    ack: `[Spur delivery: ${innerId}]`,
  },
];

describe("fakeAgentScript Cursor delivery dispatch", () => {
  it.for(scenarios)("$name retains one raw USER record", async (scenario, { signal }) => {
    expect(isCursorDeliveryId(deliveryId)).toBe(true);
    expect(isCursorDeliveryId(innerId)).toBe(true);
    expect(isCursorDeliveryId(deliveryId.toUpperCase())).toBe(true);
    await withFakeAgent(
      "cursor",
      signal,
      async ({ child, closed, output, waitForOutput, transcript }) => {
        child.stdin.write(`${scenario.input}\n`);
        if (scenario.kind === "exit") {
          expect(child.stdin.writableEnded).toBe(false);
          await closed;
          expect(child.exitCode).toBe(0);
          expect(output()).not.toContain("ack:");
        } else {
          await waitForOutput((text) =>
            scenario.kind === "menu"
              ? text.includes("Entered plan mode")
              : text.split("\n").includes(`ack: ${scenario.ack}`),
          );
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
          expect(child.stdin.writableEnded).toBe(false);
        }
        const records = await transcript();
        const texts = records
          .filter((record) => record.role === "user")
          .map((record) => record.message?.content?.find((block) => block.type === "text")?.text);
        expect(texts).toEqual([scenario.input]);
        if (scenario.kind === "menu") {
          expect(
            records.some((record) =>
              record.message?.content?.some(
                (block) => block.type === "tool_use" && block.name === "AskUserQuestion",
              ),
            ),
          ).toBe(true);
          expect(output()).not.toContain("ack:");
        }
      },
    );
  });
});

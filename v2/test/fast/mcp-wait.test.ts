import { afterEach, expect, it } from "vitest";
import { McpGateway } from "../../src/mcp-gateway.js";
import { mcpFixture, session } from "./mcp-fixture.js";
import { encodeMcpResult } from "../../src/mcp-results.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const fixture = await mcpFixture();
  cleanups.push(fixture.close);
  const gateway = await McpGateway.create(fixture.configPath);
  cleanups.push(() => gateway.close());
  return { fixture, gateway };
}
it("never treats old idle as send completion; recognizes matching new user then assistant", async () => {
  const { fixture, gateway } = await setup();
  fixture.state.conversation = {
    messages: [],
    entries: [],
    durationMs: 0,
    state: "waiting",
    startIndex: 0,
    totalEntries: 0,
  };
  const receipt = await gateway.dispatch(
    {
      operationId: "send_message",
      pathParams: { sessionId: session.id },
      body: { message: "next" },
    },
    AbortSignal.timeout(5000),
  );
  const after = String(receipt.after);
  expect(
    await gateway.wait({ sessionId: session.id, after, timeoutMs: 5 }, AbortSignal.timeout(1000)),
  ).toMatchObject({ reason: "timeout", submitted: false });
  fixture.state.conversation = {
    messages: [],
    entries: [
      { kind: "message", role: "user", text: "next" },
      { kind: "message", role: "assistant", text: "done" },
    ],
    durationMs: 0,
    state: "waiting",
    startIndex: 0,
    totalEntries: 2,
  };
  expect(
    await gateway.wait({ sessionId: session.id, after, timeoutMs: 50 }, AbortSignal.timeout(1000)),
  ).toMatchObject({ reason: "ready", submitted: true, progressed: true });
});
it("keeps attachment delivery unconfirmed and detects daemon instance reset", async () => {
  const { fixture, gateway } = await setup();
  const receipt = await gateway.dispatch(
    {
      operationId: "send_message",
      pathParams: { sessionId: session.id },
      body: { message: "next", attachments: [{ name: "x", data: "eA==" }] },
    },
    AbortSignal.timeout(5000),
  );
  expect(
    await gateway.wait(
      { sessionId: session.id, after: String(receipt.after), timeoutMs: 100 },
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({ reason: "timeout", unconfirmed: true });
  fixture.state.info.lifecycleInstanceId = "new";
  expect(
    await gateway.wait(
      { sessionId: session.id, after: String(receipt.after), timeoutMs: 100 },
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({ reason: "cursor-reset" });
});
it("holds queued/unconfirmed submissions and reports question, terminal and cancellation", async () => {
  const { fixture, gateway } = await setup();
  fixture.state.conversation = {
    messages: [],
    entries: [],
    durationMs: 0,
    state: "waiting",
    startIndex: 0,
    totalEntries: 0,
  };
  const receipt = await gateway.dispatch(
    {
      operationId: "send_message",
      pathParams: { sessionId: session.id },
      body: { message: "next" },
    },
    AbortSignal.timeout(5000),
  );
  const after = String(receipt.after);
  fixture.state.conversation = {
    messages: [],
    entries: [
      { kind: "message", role: "user", text: "next" },
      { kind: "message", role: "assistant", text: "answer" },
    ],
    durationMs: 0,
    state: "waiting",
    startIndex: 0,
    totalEntries: 2,
  };
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}`
      ? {
          value: {
            ...session,
            queuedMessages: { messages: ["next"], awaitingPrompt: true },
            submitUnconfirmedAt: "2026-01-01",
          },
        }
      : undefined;
  expect(
    await gateway.wait({ sessionId: session.id, after, timeoutMs: 100 }, AbortSignal.timeout(1000)),
  ).toMatchObject({ reason: "timeout", pending: true });
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}`
      ? { value: { ...session, state: "needs_input" } }
      : undefined;
  expect(
    await gateway.wait({ sessionId: session.id, after, timeoutMs: 100 }, AbortSignal.timeout(1000)),
  ).toMatchObject({
    reason: "ready",
    state: "needs_input",
    question: { operationId: "get_conversation" },
  });
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}` ? { value: { ...session, status: "completed" } } : undefined;
  expect(
    await gateway.wait(
      { sessionId: session.id, after, until: "terminal", timeoutMs: 100 },
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({ reason: "terminal", status: "completed" });
  await expect(
    gateway.wait({ sessionId: session.id }, AbortSignal.abort(new Error("cancelled"))),
  ).rejects.toThrow("cancelled");
});
it("bounds escaped wait previews while retaining resolvable raw history", async () => {
  const { fixture, gateway } = await setup();
  fixture.state.conversation = {
    messages: [],
    entries: Array.from({ length: 3 }, () => ({
      kind: "message" as const,
      role: "assistant" as const,
      text: "\0".repeat(8192),
    })),
    durationMs: 0,
    state: "waiting",
    startIndex: 0,
    totalEntries: 3,
  };
  const result = await gateway.wait(
    { sessionId: session.id, timeoutMs: 1000 },
    AbortSignal.timeout(1500),
  );
  expect(result).toMatchObject({
    reason: "ready",
    messagesPreview: true,
    messages: expect.arrayContaining([expect.objectContaining({ textTruncated: true })]),
    conversation: { operationId: "get_conversation" },
  });
  expect(Buffer.byteLength(JSON.stringify(encodeMcpResult(result)))).toBeLessThanOrEqual(131072);
});
it("requires a new indexed question after submission and waits through delayed queue before answer flow", async () => {
  const { fixture, gateway } = await setup();
  let state = "needs_input";
  let queued = false;
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}`
      ? {
          value: {
            ...session,
            state,
            agentSessionId: "generation-1",
            queuedMessages: { messages: queued ? ["next"] : [], awaitingPrompt: false },
          },
        }
      : path === `/sessions/${session.id}/answer`
        ? { status: 200, value: { ok: true } }
        : undefined;
  fixture.state.conversation = {
    messages: [],
    entries: [{ kind: "question", header: "old", prompt: "Old question" }],
    durationMs: 0,
    state: "needs_input",
    startIndex: 0,
    totalEntries: 1,
  };
  const receipt = await gateway.dispatch(
    {
      operationId: "send_message",
      pathParams: { sessionId: session.id },
      body: { message: "next" },
    },
    AbortSignal.timeout(1000),
  );
  const after = String(receipt.after);
  fixture.state.conversation.entries.push({ kind: "message", role: "user", text: "next" });
  fixture.state.conversation.totalEntries = 2;
  expect(
    await gateway.wait({ sessionId: session.id, after, timeoutMs: 100 }, AbortSignal.timeout(1000)),
  ).toMatchObject({ reason: "timeout", submitted: true, progressed: false });
  // Even a misbehaving upstream returning an old row must not pass its index.
  fixture.state.override = (path) =>
    path.includes("/conversation?from=2")
      ? { value: { startIndex: 0, entries: [{ kind: "question", prompt: "Old question" }] } }
      : path === `/sessions/${session.id}`
        ? { value: { ...session, state, agentSessionId: "generation-1" } }
        : undefined;
  expect(
    await gateway.wait({ sessionId: session.id, after, timeoutMs: 100 }, AbortSignal.timeout(1000)),
  ).toMatchObject({ reason: "timeout", progressed: false });
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}`
      ? {
          value: {
            ...session,
            state,
            agentSessionId: "generation-1",
            queuedMessages: { messages: queued ? ["next"] : [], awaitingPrompt: false },
          },
        }
      : path === `/sessions/${session.id}/answer`
        ? { status: 200, value: { ok: true } }
        : undefined;
  fixture.state.conversation.entries.push({
    kind: "question",
    header: "new",
    prompt: "Choose next",
    options: [{ label: "Continue", index: 0 }],
  });
  fixture.state.conversation.totalEntries = 3;
  queued = true;
  expect(
    await gateway.wait({ sessionId: session.id, after, timeoutMs: 100 }, AbortSignal.timeout(1000)),
  ).toMatchObject({ reason: "timeout", pending: true, progressed: true });
  queued = false;
  expect(
    await gateway.wait({ sessionId: session.id, after, timeoutMs: 100 }, AbortSignal.timeout(1000)),
  ).toMatchObject({ reason: "ready", state: "needs_input", submitted: true, progressed: true });
  expect(
    await gateway.dispatch(
      {
        operationId: "answer_question",
        pathParams: { sessionId: session.id },
        body: { optionIndex: 0 },
      },
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({ ok: true });
  expect(fixture.calls.at(-1)).toMatchObject({
    method: "POST",
    path: `/sessions/${session.id}/answer`,
    body: { optionIndex: 0 },
  });
  state = "waiting";
  fixture.state.conversation.entries.push({
    kind: "message",
    role: "assistant",
    text: "Finished after choice",
  });
  fixture.state.conversation.totalEntries = 4;
  expect(
    await gateway.wait({ sessionId: session.id, after, timeoutMs: 100 }, AbortSignal.timeout(1000)),
  ).toMatchObject({ reason: "ready", state: "waiting", progressed: true });
});
it("scans beyond100 entries and rejects progress belonging to an earlier identical submission", async () => {
  const { fixture, gateway } = await setup();
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}`
      ? { value: { ...session, state: "needs_input" } }
      : undefined;
  fixture.state.conversation = {
    messages: [],
    entries: [],
    durationMs: 0,
    state: "needs_input",
    startIndex: 0,
    totalEntries: 0,
  };
  const receipt = await gateway.dispatch(
    {
      operationId: "send_message",
      pathParams: { sessionId: session.id },
      body: { message: "next" },
    },
    AbortSignal.timeout(1000),
  );
  fixture.state.conversation.entries = [
    { kind: "message", role: "user", text: "next" },
    { kind: "message", role: "assistant", text: "earlier answer" },
    ...Array.from({ length: 147 }, () => ({ kind: "reasoning" as const, text: "work" })),
    { kind: "message", role: "user", text: "next" },
  ];
  fixture.state.conversation.totalEntries = 150;
  expect(
    await gateway.wait(
      { sessionId: session.id, after: String(receipt.after), timeoutMs: 200 },
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({ reason: "timeout", submitted: true, progressed: false, nextFrom: 150 });
  fixture.state.conversation.entries.push({
    kind: "message",
    role: "assistant",
    text: "latest answer",
  });
  fixture.state.conversation.totalEntries = 151;
  expect(
    await gateway.wait(
      { sessionId: session.id, after: String(receipt.after), timeoutMs: 200 },
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({ reason: "ready", progressed: true, nextFrom: 151 });
});

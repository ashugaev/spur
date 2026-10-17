import { afterEach, expect, it } from "vitest";
import { McpGateway } from "../../src/mcp-gateway.js";
import { mcpFixture, session } from "./mcp-fixture.js";
import { encodeMcpResult } from "../../src/mcp-results.js";
import nativeFollowups from "../fixtures/mcp-followup-correlation.json" with { type: "json" };
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

it.each(Object.entries(nativeFollowups))(
  "correlates the full native %s followup before later assistant progress",
  async (agent, native) => {
    const { fixture, gateway } = await setup();
    fixture.state.override = (path) =>
      path === `/sessions/${session.id}` ? { value: { ...session, agent } } : undefined;
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
        body: { message: native.sent },
      },
      AbortSignal.timeout(1000),
    );
    fixture.state.conversation.entries = [
      { kind: "message", role: "user", text: native.observed },
      { kind: "message", role: "assistant", text: "Followup complete" },
    ];
    fixture.state.conversation.totalEntries = 2;
    expect(
      await gateway.wait(
        { sessionId: session.id, after: String(receipt.after), timeoutMs: 100 },
        AbortSignal.timeout(1000),
      ),
    ).toMatchObject({ reason: "ready", submitted: true, progressed: true });
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  },
);
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

const cursorEnvelope = (payload: string) =>
  `<timestamp>Saturday, Oct 17, 2026, 10:09 AM (UTC)</timestamp>\n<user_query>\n${payload}\n</user_query>`;
async function correlation(agent: string, intended: string, observed: string, reply = true) {
  const { fixture, gateway } = await setup();
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}` ? { value: { ...session, agent } } : undefined;
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
      body: { message: intended },
    },
    AbortSignal.timeout(1000),
  );
  fixture.state.conversation.entries = [
    { kind: "message", role: "user", text: observed },
    ...(reply ? [{ kind: "message" as const, role: "assistant" as const, text: "Done" }] : []),
  ];
  fixture.state.conversation.totalEntries = fixture.state.conversation.entries.length;
  return {
    fixture,
    gateway,
    after: String(receipt.after),
    wait: () =>
      gateway.wait(
        { sessionId: session.id, after: String(receipt.after), timeoutMs: 100 },
        AbortSignal.timeout(1000),
      ),
  };
}
const fullTarget = `${"same-prefix-".repeat(50)}expected suffix`;
const whitespaceTarget = "one  two\tthree\nfour\r\nfive é";
it.each([
  ["cursor", fullTarget, cursorEnvelope(`${"same-prefix-".repeat(50)}wrong suffix`)],
  ["cursor", "next", `prefix${cursorEnvelope("next")}`],
  ["cursor", "next", `${cursorEnvelope("next")}suffix`],
  ["cursor", "next", `${cursorEnvelope("next")}\n`],
  ["cursor", "next", cursorEnvelope(cursorEnvelope("next"))],
  ["cursor", "next", `${cursorEnvelope("next")}${cursorEnvelope("next")}`],
  ["cursor", "next", "<timestamp> </timestamp>\n<user_query>\nnext\n</user_query>"],
  ["cursor", "next", "<timestamp>bad<header</timestamp>\n<user_query>\nnext\n</user_query>"],
  ["cursor", "next", "<timestamp>header\u2028line</timestamp>\n<user_query>\nnext\n</user_query>"],
  ["cursor", "next", "<timestamp>header\u2029line</timestamp>\n<user_query>\nnext\n</user_query>"],
  ["cursor", "next", "<timestamp>header</timestamp>\n<user_query mode='x'>\nnext\n</user_query>"],
  ["cursor", "next", "<timestamp>header</timestamp>\n<USER_QUERY>\nnext\n</USER_QUERY>"],
  ["cursor", "next", "<timestamp>header</timestamp>\r\n<user_query>\r\nnext\r\n</user_query>"],
  ["cursor", "next", "<timestamp>header</timestamp>\n<user_query>\nnext</user_query>"],
  ["cursor", "next", "<timestamp>header</timestamp>\n<user_query>\nnext\n"],
  [
    "cursor",
    "next",
    "<timestamp>header</timestamp>\n<timestamp>other</timestamp>\n<user_query>\nnext\n</user_query>",
  ],
  [
    "cursor",
    "next<user_query>literal</user_query>",
    cursorEnvelope("next<user_query>literal</user_query>"),
  ],
  [
    "cursor",
    "next<timestamp>literal</timestamp>",
    cursorEnvelope("next<timestamp>literal</timestamp>"),
  ],
  ["cursor", "next", cursorEnvelope(" next")],
  ["cursor", "next", cursorEnvelope("next ")],
  ["cursor", whitespaceTarget, cursorEnvelope("one two three\nfour\nfive é")],
  ["cursor", "é", cursorEnvelope("e\u0301")],
  ["cursor", "next", "next "],
  ["codex", "next", cursorEnvelope("next")],
  ["opencode", "next", cursorEnvelope("next")],
  ["unknown", "next", cursorEnvelope("next")],
  ["claude", "next", "next "],
  ["unknown", "next", "next "],
  ["opencode", "next", "next  "],
  ["opencode", "next", " next"],
  ["opencode", "next", "next\t"],
  ["opencode", "next", "next\n"],
  ["opencode", "next", "next\u00a0"],
  ["opencode", whitespaceTarget, "one two three\nfour\nfive é "],
  ["opencode", fullTarget, `${"same-prefix-".repeat(50)}wrong suffix `],
])("rejects unrecognized %s followup transformations: %s", async (agent, intended, observed) => {
  if (agent === undefined || intended === undefined || observed === undefined)
    throw new Error("Invalid correlation case");
  const scenario = await correlation(agent, intended, observed);
  expect(await scenario.wait()).toMatchObject({
    reason: "timeout",
    submitted: false,
    progressed: false,
  });
  expect(scenario.fixture.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
it.each([
  ["cursor", whitespaceTarget, cursorEnvelope(whitespaceTarget)],
  ["opencode", whitespaceTarget, `${whitespaceTarget} `],
  ["unknown", whitespaceTarget, whitespaceTarget],
  ["claude", whitespaceTarget, whitespaceTarget],
  ["codex", whitespaceTarget, whitespaceTarget],
  ["cursor", cursorEnvelope("literal envelope"), cursorEnvelope("literal envelope")],
  ["cursor", "x".repeat(8192), "x".repeat(8192)],
])(
  "matches complete %s followups without changing intended whitespace",
  async (agent, intended, observed) => {
    if (agent === undefined || intended === undefined || observed === undefined)
      throw new Error("Invalid correlation case");
    const scenario = await correlation(agent, intended, observed);
    const result = await scenario.wait();
    expect(result).toMatchObject({ reason: "ready", submitted: true, progressed: true });
    expect(Buffer.byteLength(JSON.stringify(encodeMcpResult(result)))).toBeLessThanOrEqual(131072);
  },
);
it.each([
  ["cursor", "x".repeat(8192), "x".repeat(8193)],
  ["cursor", "x".repeat(8192), cursorEnvelope("x".repeat(8192))],
  ["opencode", "x".repeat(8192), `${"x".repeat(8192)} `],
  ["unknown", "\0".repeat(8192), "\0".repeat(8192)],
])(
  "never proves complete %s submission from a truncated projected prefix",
  async (agent, intended, observed) => {
    if (agent === undefined || intended === undefined || observed === undefined)
      throw new Error("Invalid correlation case");
    const scenario = await correlation(agent, intended, observed);
    const address = scenario.fixture.server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const projected = (await (
      await fetch(
        `http://127.0.0.1:${address.port}/sessions/${session.id}/conversation?view=messages&limit=100`,
      )
    ).json()) as { messages: { textTruncated?: boolean }[] };
    expect(projected.messages[0]?.textTruncated).toBe(true);
    const result = await scenario.wait();
    expect(result).toMatchObject({ reason: "timeout", submitted: false, progressed: false });
    expect(Buffer.byteLength(JSON.stringify(encodeMcpResult(result)))).toBeLessThanOrEqual(131072);
  },
);
it.each(Object.entries(nativeFollowups))(
  "requires later progress and cleared delivery holds for native %s",
  async (agent, native) => {
    const scenario = await correlation(agent, native.sent, native.observed, false);
    expect(await scenario.wait()).toMatchObject({
      reason: "timeout",
      submitted: true,
      progressed: false,
    });
    scenario.fixture.state.conversation.entries.push({
      kind: "message",
      role: "assistant",
      text: "Done",
    });
    scenario.fixture.state.conversation.totalEntries = 2;
    for (const hold of [
      { queuedMessages: { messages: [native.sent], awaitingPrompt: true } },
      { queuedMessageTyped: { message: native.sent, typedAt: "2026-10-17T00:00:00Z" } },
      { submitUnconfirmedAt: "2026-10-17T00:00:00Z" },
    ]) {
      scenario.fixture.state.override = (path) =>
        path === `/sessions/${session.id}` ? { value: { ...session, agent, ...hold } } : undefined;
      expect(await scenario.wait()).toMatchObject({
        reason: "timeout",
        submitted: true,
        progressed: true,
        pending: true,
      });
    }
    scenario.fixture.state.override = (path) =>
      path === `/sessions/${session.id}` ? { value: { ...session, agent } } : undefined;
    expect(await scenario.wait()).toMatchObject({
      reason: "ready",
      submitted: true,
      progressed: true,
    });
  },
);
it.each(Object.entries(nativeFollowups))(
  "keeps old/latest submission and generation baselines for native %s",
  async (agent, native) => {
    const { fixture, gateway } = await setup();
    let generation = "generation-one";
    fixture.state.override = (path) =>
      path === `/sessions/${session.id}`
        ? { value: { ...session, agent, agentSessionId: generation } }
        : undefined;
    fixture.state.conversation = {
      messages: [],
      entries: [
        { kind: "message", role: "user", text: native.observed },
        { kind: "message", role: "assistant", text: "Old answer" },
      ],
      durationMs: 0,
      state: "waiting",
      startIndex: 0,
      totalEntries: 2,
    };
    const receipt = await gateway.dispatch(
      {
        operationId: "send_message",
        pathParams: { sessionId: session.id },
        body: { message: native.sent },
      },
      AbortSignal.timeout(1000),
    );
    const wait = () =>
      gateway.wait(
        { sessionId: session.id, after: String(receipt.after), timeoutMs: 100 },
        AbortSignal.timeout(1000),
      );
    fixture.state.conversation.entries.push({
      kind: "message",
      role: "assistant",
      text: "Unrelated progress",
    });
    fixture.state.conversation.totalEntries = 3;
    expect(await wait()).toMatchObject({ reason: "timeout", submitted: false });
    fixture.state.conversation.entries.push(
      { kind: "message", role: "user", text: native.observed },
      { kind: "message", role: "assistant", text: "Earlier answer" },
      { kind: "message", role: "user", text: native.observed },
    );
    fixture.state.conversation.totalEntries = 6;
    expect(await wait()).toMatchObject({ reason: "timeout", submitted: true, progressed: false });
    fixture.state.conversation.entries.push({
      kind: "message",
      role: "assistant",
      text: "Latest answer",
    });
    fixture.state.conversation.totalEntries = 7;
    expect(await wait()).toMatchObject({ reason: "ready", submitted: true, progressed: true });
    generation = "generation-two";
    expect(await wait()).toMatchObject({ reason: "cursor-reset" });
  },
);
it("selects transformations from current session agent rather than receipt or request body", async () => {
  const { fixture, gateway } = await setup();
  let agent = "cursor";
  fixture.state.override = (path) =>
    path === `/sessions/${session.id}` ? { value: { ...session, agent } } : undefined;
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
      body: { message: "next", agent: "cursor" },
    },
    AbortSignal.timeout(1000),
  );
  fixture.state.conversation.entries = [
    { kind: "message", role: "user", text: cursorEnvelope("next") },
    { kind: "message", role: "assistant", text: "Done" },
  ];
  fixture.state.conversation.totalEntries = 2;
  agent = "codex";
  expect(
    await gateway.wait(
      { sessionId: session.id, after: String(receipt.after), timeoutMs: 100 },
      AbortSignal.timeout(1000),
    ),
  ).toMatchObject({ reason: "timeout", submitted: false, progressed: false });
});
it.each(Object.entries(nativeFollowups))(
  "requires new indexed question evidence after native %s submission",
  async (agent, native) => {
    const { fixture, gateway } = await setup();
    fixture.state.override = (path) =>
      path === `/sessions/${session.id}`
        ? { value: { ...session, agent, state: "needs_input" } }
        : undefined;
    fixture.state.conversation = {
      messages: [],
      entries: [{ kind: "question", header: "Old", prompt: "Old question" }],
      durationMs: 0,
      state: "needs_input",
      startIndex: 0,
      totalEntries: 1,
    };
    const receipt = await gateway.dispatch(
      {
        operationId: "send_message",
        pathParams: { sessionId: session.id },
        body: { message: native.sent },
      },
      AbortSignal.timeout(1000),
    );
    const wait = () =>
      gateway.wait(
        { sessionId: session.id, after: String(receipt.after), timeoutMs: 100 },
        AbortSignal.timeout(1000),
      );
    fixture.state.conversation.entries.push({
      kind: "message",
      role: "user",
      text: native.observed,
    });
    fixture.state.conversation.totalEntries = 2;
    expect(await wait()).toMatchObject({ reason: "timeout", submitted: true, progressed: false });
    fixture.state.conversation.entries.push({
      kind: "question",
      header: "New",
      prompt: "New question",
    });
    fixture.state.conversation.totalEntries = 3;
    expect(await wait()).toMatchObject({
      reason: "ready",
      submitted: true,
      progressed: true,
      state: "needs_input",
    });
  },
);

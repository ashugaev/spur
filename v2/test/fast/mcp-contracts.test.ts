import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAEMON_OPERATIONS,
  describeDaemonOperations,
  getDaemonOperation,
  type DaemonOperationSummary,
} from "../../src/daemon-contracts.js";
import {
  contractFingerprint,
  interfaceFields,
  inventoryDaemonRoutes,
} from "../helpers/daemon-contract-coverage.js";
import { createTempDir, findFreePort } from "../helpers/common.js";
import { writeSession } from "../../src/metadata.js";
import { startServer } from "../../src/server.js";
import type { CronJobEditDraft } from "../../src/types.js";

const source = (name: string) => readFile(new URL(`../../src/${name}`, import.meta.url), "utf8");

// Review contract metadata when these parser/DTO implementations change; never regenerate blindly.
const reviewedFingerprints = {
  "server.ts": "35712b1df5e9155d02337c8c90f6890746d90eaba5847908090211485d993262",
  "types.ts": "1c5d664cb3863752a15f28aadbb6eb3d528468563d9663ad7262f66132fb451a",
  "cron-job-editor.ts": "33fc7b2993819693ef511d9312f9eb8f4260feb2f263421aec2d4e5ac613ec06",
  "session-service.ts": "d07e0f22b56124a42aae6e755f78d52280903f4a79bea2c9ae66b6515b7b8f9b",


  "session-lifecycle.ts": "11ed4e84c26d589f92627e9d09fc89141f273ae99199a0263d6c2a3b49acb72c",
  "session-memory.ts": "837a7052b62b977b59f117e344b83b0f507298ce0d716c1ab637ead711060c42",
  "shared-memory.ts": "f5804ebc0592f40c37cf30a1545d88b37075cd6e7e63b3c9e1817bf42c93de67",
  "wake-schedule.ts": "7232e30422a546b50e136334c9737934370b2ac04bfc4ca3a62c03e811ba1452",
  "agents/models.ts": "bfeaa482e8d73bb763d698bb47aca8f35ff6549c9bbd8c28181991850da116f0",
  "todo.ts": "2170888ce1a3527e303f5f6b27edd7ccbfabf2d9ad26d22cdc9518f891095288",
  "auto-ping.ts": "71ec9460c075728fcba93167d1d1f2d8e25df3188d90166e52a7a473f198428b",
  "review-interface.ts": "3cd868f605946f29e66e96b0721adddebd9b2783a9101924d8ec489a1e37122b",
  "review-interface-consent.ts": "03fc56319c45e14e4685e169387ee96677487abf12aaea0ad8a313090cda7d3d",
};

afterEach(() => vi.restoreAllMocks());

describe("daemon MCP operation contracts", () => {
  it("covers every concrete imperative dispatch branch with no duplicates", async () => {
    const routes = inventoryDaemonRoutes(await source("server.ts"));
    const contracts = DAEMON_OPERATIONS.map(
      (entry) =>
        `${entry.method} ${entry.path.replace(/\{([^}]+)\}/g, (_match, name: string) => (entry.catchAllPathParams?.includes(name) ? "{*}" : "{}"))}`,
    ).sort();
    expect(routes).toHaveLength(83);
    expect(contracts).toEqual(routes);
    expect(new Set(DAEMON_OPERATIONS.map((entry) => entry.operationId)).size).toBe(83);
    expect(getDaemonOperation("spawn_session")?.path).toBe("/sessions");
    expect(getDaemonOperation("spawn_background_session")?.path).toBe("/sessions/background");
    expect(getDaemonOperation("missing")).toBeUndefined();
  });

  it.each(Object.entries(reviewedFingerprints))(
    "pins reviewed parser and referenced DTO AST: %s",
    async (name, fingerprint) => {
      expect(
        contractFingerprint(await source(name)),
        `Review daemon-contracts.ts against ${name} before updating this fingerprint`,
      ).toBe(fingerprint);
    },
  );

  it("detects route additions, DTO additions and parser behavior changes", async () => {
    const server = await source("server.ts");
    const routeMutation = server.replace(
      'if (method === "GET" && path === "/info")',
      'if (method === "GET" && path === "/info-new")',
    );
    expect(inventoryDaemonRoutes(routeMutation)).not.toEqual(inventoryDaemonRoutes(server));
    const types = await source("types.ts");
    const dtoMutation = types.replace(
      "export interface SpawnSessionRequest {",
      "export interface SpawnSessionRequest { newField?: string;",
    );
    expect(contractFingerprint(dtoMutation)).not.toBe(contractFingerprint(types));
    expect(interfaceFields(dtoMutation, "SpawnSessionRequest")).toContainEqual({
      name: "newField",
      required: false,
    });
    const parserMutation = server.replace(
      'throw new Error("Unsupported ToDo action")',
      'throw new Error("Changed ToDo policy")',
    );
    expect(parserMutation).not.toBe(server);
    expect(contractFingerprint(parserMutation)).not.toBe(contractFingerprint(server));
    expect(contractFingerprint(`// comment\n${server}`)).toBe(contractFingerprint(server));
  });

  it("fails closed on unfamiliar dispatch/matcher syntax", async () => {
    const server = await source("server.ts");
    expect(() =>
      inventoryDaemonRoutes(
        server.replace(
          'method === "GET" && path === "/info"',
          'method == "GET" && path === "/info"',
        ),
      ),
    ).toThrow("Unknown method predicate");
    expect(() =>
      inventoryDaemonRoutes(server.replace('path === "/info"', 'path.startsWith("/info")')),
    ).toThrow("Unknown dispatch predicate");
    expect(() =>
      inventoryDaemonRoutes(
        server.replace(
          "const sessionId = path.match(/^\\/sessions\\/([^/]+)$/)?.[1]",
          "const sessionId = path.match(/^\\/sessions\\/(foo)?$/)?.[1]",
        ),
      ),
    ).toThrow("Unknown route regex syntax");
    expect(() => inventoryDaemonRoutes("const broken =")).toThrow("syntactically invalid");
  });

  it("inventories every combined method once without counting nested body parsing", () => {
    expect(
      inventoryDaemonRoutes(`const handleRequest = () => {
      if ((method === "GET" || method === "PATCH") && path === "/edit") {
        if (method === "PATCH") readBody();
      }
    };`),
    ).toEqual(["GET /edit", "PATCH /edit"]);
  });

  it.each([
    'if (method === "PATCH") readBody();',
    'if ((method === "GET" || path === "/edit")) dispatch();',
    'if ((method === "GET" || method == "PATCH") && path === "/edit") dispatch();',
    'if (method === "HEAD" && path === "/edit") dispatch();',
    'if (method === "GET" && path === "/edit") { if (method === "PATCH") readBody(); }',
    'if (method === "GET" && path === "/edit") { if (method === "GET" && path === "/hidden") dispatch(); }',
    'if ((method === "GET" || method === "PATCH") && path === "/edit") { if (method === "PATCH" && path.startsWith("/hidden")) dispatch(); }',
    'if ((method === "GET" || method === "PATCH") && path === "/edit") { if (method === "PATCH" && path !== "/edit") dispatch(); }',
  ])("rejects unproven method/dispatch refinements", (branch) => {
    expect(() => inventoryDaemonRoutes(`const handleRequest = () => { ${branch} };`)).toThrow(
      /Unknown/,
    );
  });

  it("rejects duplicate concrete routes in combined or separate dispatches", () => {
    expect(() =>
      inventoryDaemonRoutes(`const handleRequest = () => {
      if ((method === "GET" || method === "PATCH") && path === "/edit") dispatch();
      if (method === "PATCH" && path === "/edit") dispatchAgain();
    };`),
    ).toThrow("Duplicate daemon routes");
  });

  it("keeps all request DTO fields, including optional task/provider inputs", async () => {
    const types = await source("types.ts");
    const mappings = [
      ["spawn_session", "SpawnSessionRequest"],
      ["spawn_background_session", "SpawnSessionRequest"],
      ["send_message", "SendMessageRequest"],
      ["restore_session", "RestoreSessionRequest"],
      ["reopen_session", "RestoreSessionRequest"],
      ["respawn_session", "RespawnSessionRequest"],
      ["handoff_session", "HandoffSessionRequest"],
      ["update_session_slots", "UpdateSessionSlotsRequest"],
      ["reply_to_source", "SourceReplyRequest"],
      ["create_project", "CreateProjectRequest"],
      ["update_project", "UpdateProjectRequest"],
      ["subscribe_session_states", "SubscribeSessionStatesRequest"],
      ["run_service", "RunServiceRequest"],
      ["start_sidecar", "StartSidecarRequest"],
      ["complete_session", "CompleteSessionRequest"],
      ["kill_session", "KillSessionRequest"],
      ["save_cron_job_draft", "CronJobEditUpdate"],
    ] as const;
    for (const [id, dto] of mappings) {
      const actual = getDaemonOperation(id)?.body?.fields.map(({ name, required }) => ({
        name,
        required,
      }));
      expect(
        actual?.sort((a, b) => a.name.localeCompare(b.name)),
        id,
      ).toEqual(interfaceFields(types, dto).sort((a, b) => a.name.localeCompare(b.name)));
    }
    for (const id of [
      "spawn_session",
      "spawn_background_session",
      "send_message",
      "respawn_session",
    ]) {
      expect(
        getDaemonOperation(id)?.body?.fields.find((entry) => entry.name === "attachments")?.type,
      ).toContain("name:string,data:string");
    }
  });

  it("describes the scoped Cron disk draft and nullable save-only contract", async () => {
    for (const operationId of ["get_cron_job_draft", "save_cron_job_draft"]) {
      const operation = getDaemonOperation(operationId);
      expect(operation?.path).toBe("/projects/cron/edit");
      expect(operation?.query.map(({ name, required }) => ({ name, required }))).toEqual([
        { name: "project", required: true },
        { name: "source", required: true },
        { name: "trigger", required: true },
      ]);
      expect(operation?.sources).toContain("v2/src/cron-job-editor.ts");
      expect(operation?.responses.map(({ status }) => status)).toContain(422);
    }
    const read = getDaemonOperation("get_cron_job_draft");
    expect(read?.method).toBe("GET");
    expect(read?.body).toBeNull();
    const save = getDaemonOperation("save_cron_job_draft");
    expect(save?.method).toBe("PATCH");
    const definitions = save?.body?.definitions;
    if (!definitions) throw new Error("Missing editor block contract");
    expect(interfaceFields(definitions, "CronJobEditBlock")).toEqual(
      interfaceFields(await source("types.ts"), "CronJobEditBlock"),
    );
    for (const key of ["agent", "model", "reasoningEffort"]) {
      expect(definitions).toMatch(new RegExp(`${key}: [^;]+\\|null;`));
    }
    expect(save?.responses.find(({ status }) => status === 200)?.description).toContain(
      'activation:"pending"',
    );
  });

  it("provides examples, path/query/body metadata, errors and source references for every operation", () => {
    for (const entry of DAEMON_OPERATIONS) {
      expect(entry.summary.length, entry.operationId).toBeGreaterThan(12);
      expect(entry.sources).toContain("v2/src/server.ts");
      expect(entry.responses.some((response) => response.status >= 400)).toBe(true);
      expect(entry.examples.length).toBeGreaterThan(0);
      for (const example of entry.examples) {
        expect(Object.keys(example.pathParams ?? {}).sort()).toEqual([...entry.pathParams].sort());
        const requiredFields =
          entry.body?.fields.filter((entry) => entry.required).map((entry) => entry.name) ?? [];
        for (const name of requiredFields)
          expect(example.body, `${entry.operationId}: ${name}`).toHaveProperty(name);
        for (const name of Object.keys(example.query ?? {}))
          expect(entry.query.map((entry) => entry.name)).toContain(name);
        for (const query of entry.query.filter((entry) => entry.required))
          expect(example.query).toHaveProperty(query.name);
      }
      for (const contractField of [...entry.query, ...(entry.body?.fields ?? [])]) {
        expect(contractField.type).not.toBe("");
        expect(contractField.description).not.toBe("");
      }
    }
  });

  it("pages discovery without gaps and returns requested contract details", () => {
    const ids: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page: {
        operations: readonly DaemonOperationSummary[];
        total: number;
        nextOffset?: number;
      } = describeDaemonOperations({ offset, limit: 7 });
      ids.push(...page.operations.map((entry) => entry.operationId));
      expect(page.total).toBe(83);
      expect(
        page.operations.every(
          (entry) => Object.keys(entry).sort().join(",") === "method,operationId,path,summary",
        ),
      ).toBe(true);
      offset = page.nextOffset;
    }
    expect(ids).toEqual(DAEMON_OPERATIONS.map((entry) => entry.operationId));
    expect(
      describeDaemonOperations({ operationId: "wake_session" }).operations[0]?.body?.modes,
    ).toHaveLength(5);
    expect(() => describeDaemonOperations({ operationId: "unknown" })).toThrow(
      "Unknown daemon operation",
    );
    for (const options of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 51 }])
      expect(() => describeDaemonOperations(options)).toThrow("Operation offset");
  });
});

describe("catalog examples at the real daemon router", () => {
  async function fixture(cron = false) {
    const root = await createTempDir("spur-mcp-contract-");
    const repo = join(root, "repo");
    await mkdir(repo);
    const configPath = join(root, "spur.yaml");
    const port = await findFreePort();
    const dataDir = join(root, "data");
    await writeFile(
      configPath,
      `server:\n  host: 127.0.0.1\n  port: ${port}\ndataDir: ${dataDir}\nauthRotation:\n  switchAuth: true\nworktreeDir: ${join(root, "worktrees")}\nprojects:\n  test:\n    path: ${repo}\n${cron ? "    sources:\n      nightly: {type: cron, schedule: '0 0 1 1 *', runOnStart: false}\n    triggers:\n      audit:\n        source: nightly\n        event: cron:tick\n        spawn: {prompt: inspect tasks}\n" : ""}`,
    );
    writeSession(dataDir, {
      id: "test-contract",
      project: "test",
      agent: "codex",
      prompt: "Contract verification",
      branch: "feature/contract",
      worktree: false,
      worktreePath: repo,
      tmuxSession: "test-contract",
      launchCommand: "codex",
      status: "stopped",
      createdAt: "2026-10-17T00:00:00.000Z",
      updatedAt: "2026-10-17T00:00:00.000Z",
    });
    const server = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    const request = (
      operationId: string,
      requestBody?: unknown,
      params: Record<string, string> = {},
      query: Record<string, string> = {},
    ) => {
      const operation = getDaemonOperation(operationId);
      if (!operation) throw new Error(`Unknown example ${operationId}`);
      const values = { sessionId: "test-contract", scope: "task", key: "contract", ...params };
      let path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
        const value = values[name as keyof typeof values];
        if (!value) throw new Error(`Missing example path value: ${name}`);
        return encodeURIComponent(value);
      });
      const search = new URLSearchParams(query);
      if (search.size) path += `?${search}`;
      return fetch(`http://127.0.0.1:${port}${path}`, {
        method: operation.method,
        headers: { "content-type": "application/json", "x-spur-origin": "mcp" },
        ...(requestBody !== undefined ? { body: JSON.stringify(requestBody) } : {}),
      });
    };
    return { server, request, configPath };
  }

  it("executes scoped Cron draft/save catalog requests without changing loaded settings or sessions", async () => {
    const { server, request, configPath } = await fixture(true);
    const query = { project: "test", source: "nightly", trigger: "audit" };
    try {
      const sessionsBefore = await (await request("list_sessions")).json();
      const loadedBefore = structuredClone(server.config.projects["test"]);
      const read = await request("get_cron_job_draft", undefined, {}, query);
      expect(read.status).toBe(200);
      const draft = (await read.json()) as CronJobEditDraft;
      const body = {
        revision: draft.revision,
        schedule: "0 1 1 1 *",
        blocks: [
          { prompt: "Updated from operator MCP", agent: null, model: null, reasoningEffort: null },
        ],
      };
      const save = await request("save_cron_job_draft", body, {}, query);
      expect(save.status).toBe(200);
      expect(await save.json()).toMatchObject({
        saved: true,
        activation: "pending",
        blocks: body.blocks,
      });
      const reopened = (await (
        await request("get_cron_job_draft", undefined, {}, query)
      ).json()) as CronJobEditDraft;
      expect(reopened.revision).not.toBe(draft.revision);
      expect(reopened.blocks).toEqual(body.blocks);
      expect(await readFile(configPath, "utf8")).toContain("Updated from operator MCP");
      expect((await request("save_cron_job_draft", body, {}, query)).status).toBe(409);
      expect(
        (
          await request(
            "save_cron_job_draft",
            { ...body, revision: reopened.revision, schedule: "invalid" },
            {},
            query,
          )
        ).status,
      ).toBe(422);
      expect(server.config.projects["test"]).toEqual(loadedBefore);
      expect(await (await request("list_sessions")).json()).toEqual(sessionsBefore);
    } finally {
      await server.stop();
    }
  });

  it("executes every ToDo variant and session/shared-memory writes through MCP operator rights", async () => {
    const { server, request } = await fixture();
    try {
      const add = async () => {
        const response = await request("mutate_todo", {
          action: "add",
          text: "Inspect contract",
          reason: "Task",
        });
        expect(response.status).toBe(200);
        const value: unknown = await response.json();
        if (
          !value ||
          typeof value !== "object" ||
          !("items" in value) ||
          !Array.isArray(value.items)
        )
          throw new Error("Missing task projection");
        const last: unknown = value.items.at(-1);
        if (!last || typeof last !== "object" || !("id" in last) || typeof last.id !== "string")
          throw new Error("Missing task item ID");
        expect(last).toMatchObject({ added: { actor: { kind: "human", origin: "mcp" } } });
        return last.id;
      };
      for (const action of ["complete", "cancel"] as const) {
        const itemId = await add();
        expect((await request("mutate_todo", { action, itemId, reason: "Verified" })).status).toBe(
          200,
        );
      }
      for (const blocker of ["human", "external"] as const) {
        const itemId = await add();
        expect(
          (
            await request("mutate_todo", {
              action: "hold",
              itemId,
              reason: "Await dependency",
              blocker,
              ...(blocker === "human" ? { requiredHumanAction: "Grant access" } : {}),
            })
          ).status,
        ).toBe(200);
        expect((await request("mutate_todo", { action: "resume", itemId })).status).toBe(200);
        expect(
          (await request("mutate_todo", { action: "complete", itemId, reason: "Verified" })).status,
        ).toBe(200);
      }
      for (const invalid of [
        { action: "add", text: "Task" },
        { action: "hold", itemId: "missing", reason: "Blocked", blocker: "human" },
        {
          action: "hold",
          itemId: "missing",
          reason: "Blocked",
          blocker: "external",
          requiredHumanAction: "Invalid",
        },
        { action: "resume", itemId: "missing", reason: "Unknown field" },
      ]) {
        expect((await request("mutate_todo", invalid)).status).toBe(400);
      }
      expect(
        (
          await request("set_session_memory", {
            body: "Decision",
            kind: "note",
            tags: ["contract"],
          })
        ).status,
      ).toBe(200);
      expect((await request("get_session_memory")).status).toBe(200);
      expect((await request("resolve_session_memory")).status).toBe(200);
      expect((await request("set_session_memory", { body: 42 })).status).toBe(400);
      expect(
        (await request("set_session_memory", { body: "Decision", kind: "other" })).status,
      ).toBe(400);
      for (const scope of ["task", "project", "global"]) {
        expect(
          (await request("set_shared_memory", { body: `Decision ${scope}` }, { scope })).status,
        ).toBe(200);
        const response = await request("get_shared_memory", undefined, { scope });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          scope,
          entry: { body: `Decision ${scope}` },
        });
        expect((await request("remove_shared_memory", undefined, { scope })).status).toBe(200);
      }
      expect((await request("set_shared_memory", { body: 42 })).status).toBe(400);
      for (const wake of [
        { delayMs: 60_000, message: "Continue" },
        { at: "2099-01-01T00:00:00.000Z", message: "Continue" },
        { intervalMs: 60_000, stopCondition: "Task complete", message: "Continue" },
        { dailyAt: ["09:00"], stopCondition: "Task complete", message: "Continue" },
      ])
        expect((await request("wake_session", wake)).status).toBe(200);
      expect(
        (await request("wake_session", { target: "daily", message: "Changed reminder" })).status,
      ).toBe(200);
      for (const invalid of [
        {},
        { intervalMs: 60_000 },
        { dailyAt: ["09:00"], stopCondition: "" },
        { dailyAt: ["25:00"], stopCondition: "Done" },
        { at: "2099-01-01", delayMs: 1 },
      ]) {
        // Domain wake validation uses daemon's existing 500 error mapping.
        const response = await request("wake_session", invalid);
        expect(response.status).toBe(500);
        expect(await response.json()).toHaveProperty("error");
      }
      expect(
        (
          await request("reply_to_source", {
            message: "Reply",
            buttons: [{ text: "", value: "x" }],
          })
        ).status,
      ).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("runs discriminator examples through actual router parsers before the service boundary", async () => {
    const { server, request } = await fixture();
    const accepted = new Error("accepted contract at service boundary");
    try {
      const cases = [
        {
          operationId: "spawn_session",
          method: "spawn",
          body: {
            project: "test",
            prompt: "Inspect",
            agent: "codex",
            model: "auto",
            reasoningEffort: "high",
            planMode: true,
            restrictWrites: false,
            allowedTriggers: ["example"],
            steps: ["true"],
            branch: "feature/example",
            overrides: { worktree: false, defaultBranch: "main" },
            slots: { links: [{ label: "task", url: "https://example.com/task" }] },
            selfDestruct: { enabled: false },
            bootstrap: false,
            claudeAccountId: "account",
            bareSpawnMessage: true,
            originalTaskPrompt: "Inspect",
            reuseWorkspaceSessionId: "source",
            configPath: "instance.yaml",
            preflightBatchId: "batch",
            attachments: [{ name: "input.txt", data: "aGVsbG8=" }],
          },
        },
        {
          operationId: "spawn_background_session",
          method: "spawnInBackground",
          body: { project: "test", prompt: "Inspect", agent: "codex" },
        },
        {
          operationId: "send_message",
          method: "send",
          body: {
            message: "Continue",
            queue: true,
            interrupt: true,
            attachments: [{ name: "input.txt", data: "aGVsbG8=" }],
          },
        },
        {
          operationId: "respawn_session",
          method: "respawn",
          body: {
            prompt: "Continue",
            agent: "codex",
            reasoningEffort: null,
            startupAttachmentIds: ["file"],
            forceKillSource: true,
            terminateSessionId: "old",
          },
        },
        {
          operationId: "handoff_session",
          method: "handoff",
          body: { agent: "codex", model: "auto", reasoningEffort: null, notes: "Continue" },
        },
        {
          operationId: "update_session_slots",
          method: "updateSlots",
          body: {
            title: "Task",
            source: "agent",
            setTitleIfAbsent: true,
            links: [{ label: "task", url: "https://example.com/task" }],
            unlinkLabels: ["old"],
            tags: ["feature"],
            untags: ["bug"],
          },
        },
        {
          operationId: "reply_to_source",
          method: "replyToSource",
          body: { message: "Choose", buttons: [{ text: "Continue", value: "continue" }] },
        },
        { operationId: "enable_source_poll", method: "enableSourcePoll", body: {} },
        {
          operationId: "run_service",
          method: "runService",
          body: { command: "pnpm dev", cwd: ".", port: 4321 },
        },
        {
          operationId: "preflight_project",
          method: "preflight",
          body: {
            prompt: "Inspect",
            agent: "codex",
            overrides: { worktree: false },
            preflightBatchId: "batch",
          },
        },
        {
          operationId: "wake_session",
          method: "scheduleWake",
          body: { delayMs: 60000, message: "Continue" },
        },
        {
          operationId: "wake_session",
          method: "updateWakeMessage",
          body: { target: "interval", message: "Updated" },
        },
        {
          operationId: "wake_session",
          method: "dispatchWake",
          body: { target: "scheduled", dispatch: true },
        },
        {
          operationId: "complete_session",
          method: "complete",
          body: { scope: "session", prAction: "leave_open" },
        },
        {
          operationId: "complete_session",
          method: "completeDesk",
          body: { scope: "desk", prAction: "leave_open" },
        },
        {
          operationId: "restore_session",
          method: "restore",
          body: { operationId: "contract-restore", force: true, overrideTokenBudget: true },
        },
        { operationId: "reopen_session", method: "reopen", body: { force: true } },
        {
          operationId: "kill_session",
          method: "kill",
          body: { force: true, prAction: "leave_open" },
        },
        {
          operationId: "start_sidecar",
          method: "startSidecar",
          body: { callerSidecarName: "parent", callerSidecarDepth: 0, clearPort: 4321 },
        },
        { operationId: "sweep_sidecars", method: "sweepSidecarProcesses", body: { reap: true } },
        {
          operationId: "subscribe_session_states",
          method: "subscribeToSessionStates",
          body: { targetSessionId: "other", states: ["waiting", "needs_input"] },
        },
      ] as const;
      for (const example of cases) {
        const spy = vi.spyOn(server, example.method).mockImplementation(() => {
          throw accepted;
        });
        const response = await request(example.operationId, example.body, {
          sidecarName: "example",
          serviceId: "web",
          projectId: "test",
        });
        expect(response.status, example.operationId).toBe(500);
        expect(await response.json()).toMatchObject({ error: accepted.message });
        expect(spy, example.operationId).toHaveBeenCalledOnce();
        if (
          example.operationId !== "enable_source_poll" &&
          example.operationId !== "sweep_sidecars"
        ) {
          expect(spy.mock.calls[0], example.operationId).toEqual(
            expect.arrayContaining([expect.objectContaining(example.body)]),
          );
        }
        spy.mockRestore();
      }
      const invalid = [
        { id: "create_project", body: { displayName: "Example" } },
        { id: "remove_claude_account", body: { id: " " } },
        { id: "set_auto_update", body: { enabled: "true" } },
        { id: "switch_deploy_version", body: { version: "invalid" } },
        { id: "wake_session", body: { target: "interval", dispatch: true, message: "Forbidden" } },
        { id: "wake_session", body: { target: "daily", message: "Update", delayMs: 1 } },
        { id: "wake_session", body: { target: "unknown", message: "Update" } },
        { id: "complete_session", body: { scope: "unknown" } },
        { id: "restore_session", body: { operationId: 42 } },
        { id: "reopen_session", body: { operationId: 42 } },
        { id: "subscribe_session_states", body: { targetSessionId: "other", states: [] } },
        { id: "subscribe_session_states", body: { targetSessionId: "other", states: ["invalid"] } },
        { id: "answer_question", body: { optionIndex: -1 } },
        { id: "remove_queued_message", body: { message: " " } },
        { id: "switch_session_auth", body: { accountId: " " } },
      ];
      for (const example of invalid)
        expect((await request(example.id, example.body)).status, example.id).toBe(400);
    } finally {
      await server.stop();
    }
  });
});

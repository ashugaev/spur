/** Informational HTTP contracts. The daemon owns validation and authorization. */
export interface ContractField {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default?: string | number | boolean;
}

export interface ContractBody {
  type: string;
  fields: readonly ContractField[];
  modes?: readonly string[];
  definitions?: string;
}

export interface ContractResponse {
  status: number;
  contentType: string;
  description: string;
}

export interface DaemonOperationExample {
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

export interface DaemonOperation {
  operationId: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  pathParams: readonly string[];
  pathParameters: readonly ContractField[];
  catchAllPathParams?: readonly string[];
  maxBodyBytes: number;
  query: readonly ContractField[];
  body: ContractBody | null;
  responses: readonly ContractResponse[];
  examples: readonly DaemonOperationExample[];
  sources: readonly string[];
}

const field = (
  name: string,
  type: string,
  description: string,
  required = false,
  defaultValue?: string | number | boolean,
): ContractField => ({
  name,
  type,
  required,
  description,
  ...(defaultValue !== undefined ? { default: defaultValue } : {}),
});

const body = (
  type: string,
  fields: readonly ContractField[],
  modes?: readonly string[],
): ContractBody => ({
  type,
  fields,
  ...(modes ? { modes } : {}),
});

const agent = field(
  "agent",
  '"claude"|"codex"|"cursor"|"opencode"',
  "Provider; project/default configuration applies when omitted.",
);
const model = field("model", "string", "Provider model identifier or configured alias.");
const effort = field(
  "reasoningEffort",
  '"none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"|"ultra"',
  "Provider-supported reasoning effort; provider validates supported values.",
);
const nullableEffort: ContractField = { ...effort, type: `${effort.type}|null` };
const attachments = field(
  "attachments",
  "{name:string,data:string}[]",
  "Files: name and base64-encoded content.",
);
const overrides = field(
  "overrides",
  "{worktree?:boolean,defaultBranch?:string}",
  "Override project workspace settings.",
);
const subscriptionFields = [
  field("targetSessionId", "string", "Session whose state transitions trigger delivery.", true),
  field(
    "states",
    '("working"|"waiting"|"needs_input"|"rate_limited"|"stale"|"stopped"|"error"|"killed")[]',
    "Nonempty target states.",
    true,
  ),
  field("message", "string", "Delivery message override."),
] as const;
const spawn = body("SpawnSessionRequest", [
  field("project", "string", "Configured, unconfigured or shepherd project ID.", true),
  field("prompt", "string", "Initial task prompt."),
  attachments,
  field("steps", "string[]", "Startup shell steps."),
  agent,
  model,
  effort,
  field("mode", "string", "Configured project session mode."),
  field("planMode", "boolean", "Provider plan mode."),
  field(
    "restrictWrites",
    "boolean",
    "Agent write restriction setting; does not restrict MCP rights.",
  ),
  field("allowedTriggers", "string[]", "Allowed configured trigger IDs."),
  field("branch", "string", "Workspace branch; project naming constraints apply."),
  overrides,
  field("reuseWorkspaceSessionId", "string", "Reuse the named session workspace."),
  field("originalTaskPrompt", "string", "Original task retained across task handoffs."),
  field("bareSpawnMessage", "boolean", "Use the supplied task without normal spawn wrapping."),
  field("configPath", "string", "Project configuration path."),
  field("preflightBatchId", "string", "Reuse a project preflight batch."),
  field("slots", "{links?:{label:string,url:string}[]}", "Initial session links."),
  field("selfDestruct", "{enabled:boolean,conditions?:string}", "Automatic cleanup conditions."),
  field("bootstrap", "boolean", "Bootstrap session workspace."),
  field("claudeAccountId", "string", "Claude account ID used for launch."),
  field(
    "subscriptions",
    '{targetSessionId:string,states:("working"|"waiting"|"needs_input"|"rate_limited"|"stale"|"stopped"|"error"|"killed")[],message?:string}[]',
    "At most 20 state subscriptions; referenced sessions must exist.",
  ),
]);
const send = body("SendMessageRequest", [
  field("message", "string", "Message text; attachments may accompany the message.", true),
  attachments,
  field("queue", "boolean", "Queue delivery while session is busy."),
  field("interrupt", "boolean", "Interrupt active provider work before delivery."),
]);
const restore = body("RestoreSessionRequest", [
  field("operationId", "string", "Optional lifecycle operation ID for receipt reconciliation."),
  field(
    "force",
    "boolean",
    "Bypass duplicate-launch guard; never bypass surviving pane process guard.",
    false,
    false,
  ),
  field("overrideTokenBudget", "boolean", "Override token budget restriction.", false, false),
]);
const limit = field("limit", "integer", "Maximum returned entries.", false, 200);
const project = field("configPath", "string", "Nonblank project configuration path.", true);
const requestBodies = {
  spawn,
  send,
  restore,
  createProject: body("CreateProjectRequest", [
    field("displayName", "string", "Nonblank display name.", true),
    field("prefix", "string", "Nonblank project prefix.", true),
    field("path", "string", "Nonblank workspace root."),
    field("createMissing", "boolean", "Create missing project directory."),
  ]),
  updateProject: body("UpdateProjectRequest", [
    field("displayName", "string", "Nonblank display name.", true),
    field("prefix", "string", "Nonblank project prefix.", true),
    field("path", "string", "Nonblank workspace root.", true),
  ]),
  preflight: body("PreflightRequest", [
    field("project", "string", "Ignored: project comes from path."),
    field("prompt", "string", "Task prompt.", true),
    agent,
    overrides,
    field("preflightBatchId", "string", "Existing preflight batch ID."),
  ]),
  subscription: body("SubscribeSessionStatesRequest", subscriptionFields),
  wake: body(
    "ScheduleSessionWakeRequest | UpdateSessionWakeMessageRequest | DispatchSessionWakeRequest",
    [
      field("at", "string", "Future ISO timestamp; excludes delayMs; schedule mode only."),
      field(
        "delayMs",
        "positive finite number",
        "Relative delay in milliseconds; excludes at; schedule mode only.",
      ),
      field(
        "intervalMs",
        "positive finite number",
        "Repeating interval; stopCondition required; first wake uses at, delayMs or intervalMs.",
      ),
      field(
        "dailyAt",
        "string[]",
        "Nonempty unique local HH:MM times from 00:00 through 23:59; excludes at/delayMs/intervalMs; requires stopCondition.",
      ),
      field(
        "stopCondition",
        "string",
        "Nonblank required for interval/daily wakes; schedule mode only.",
      ),
      field(
        "message",
        "string",
        "Schedule message; nonblank required for target message update; forbidden with dispatch.",
      ),
      field(
        "target",
        '"scheduled"|"interval"|"daily"',
        "Select existing wake; excludes all schedule fields.",
      ),
      field(
        "dispatch",
        "true",
        "Dispatch selected target immediately; requires target and forbids message.",
      ),
    ],
    [
      "schedule once: omit target/intervalMs/dailyAt; exactly one of at or delayMs",
      "schedule interval: positive intervalMs and nonblank stopCondition; optional at or delayMs",
      "schedule daily: nonempty unique dailyAt and nonblank stopCondition; no at/delayMs/intervalMs",
      "update: target and nonblank message; no scheduling fields",
      "dispatch: target and dispatch:true; no message or scheduling fields",
    ],
  ),
  todo: body(
    "TodoMutationRequest",
    [
      field(
        "action",
        '"add"|"complete"|"cancel"|"hold"|"resume"',
        "Discriminator; unknown fields rejected.",
        true,
      ),
      field("text", "string", "Nonblank; required only for add."),
      field("reason", "string", "Nonblank; required for add, complete, cancel, hold."),
      field("itemId", "string", "Nonblank; required except add."),
      field("blocker", '"external"|"human"', "Required only for hold."),
      field(
        "requiredHumanAction",
        "string",
        "Nonblank required for hold with human blocker; forbidden with external blocker.",
      ),
    ],
    [
      "add:{action,text,reason}",
      "complete/cancel:{action,itemId,reason}",
      "hold:{action,itemId,reason,blocker,requiredHumanAction?}",
      "resume:{action,itemId}",
    ],
  ),
  complete: body(
    "CompleteSessionRequest",
    [
      field("operationId", "string", "Lifecycle operation ID."),
      field("scope", '"session"|"desk"', "Completion scope.", false, "session"),
      field("prAction", '"leave_open"|"close"', "Required when an open PR needs disposition."),
      field("skipPrCheck", "boolean", "Skip PR lookup.", false, false),
      field("skipRuntimeTeardown", "boolean", "Internal DTO field; HTTP parser ignores it."),
    ],
    ["session: complete one session", "desk: complete desk and children"],
  ),
  kill: body("KillSessionRequest", [
    field("force", "boolean", "Force runtime termination.", false, false),
    field("prAction", '"leave_open"|"close"', "Open PR disposition."),
    field("skipPrCheck", "boolean", "Skip PR lookup.", false, false),
  ]),
  respawn: body("RespawnSessionRequest", [
    field("prompt", "string", "Replacement task prompt."),
    attachments,
    field("startupAttachmentIds", "string[]", "Reuse retained attachment IDs."),
    field("terminateSessionId", "string", "Complete this session after replacement spawn."),
    field("forceKillSource", "boolean", "Force source runtime cleanup."),
    agent,
    model,
    nullableEffort,
  ]),
  handoff: body("HandoffSessionRequest", [
    { ...agent, required: true },
    model,
    nullableEffort,
    field("notes", "string", "Handoff context for new agent."),
  ]),
  slots: body("UpdateSessionSlotsRequest", [
    field("title", "string", "Session title."),
    field("clearTitle", "boolean", "Clear title."),
    field("setTitleIfAbsent", "boolean", "Set only when title absent."),
    field("source", '"manual"|"agent"', "Title author."),
    field("links", "{label:string,url:string}[]", "Links to set."),
    field("unlinkLabels", "string[]", "Link labels to remove."),
    field("tags", "string[]", "Tags to add."),
    field("untags", "string[]", "Tags to remove."),
  ]),
};

interface OperationOptions {
  query?: readonly ContractField[];
  body?: ContractBody;
  examples?: readonly DaemonOperationExample[];
  response?: string;
  status?: number;
  catchAllPathParams?: readonly string[];
  source?: string;
}

function operation(
  operationId: string,
  method: DaemonOperation["method"],
  path: string,
  summary: string,
  options: OperationOptions = {},
): DaemonOperation {
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[0].slice(1, -1));
  const examplePathParams = Object.fromEntries(
    pathParams.map((name) => [
      name,
      name === "scope" ? "task" : name === "path" ? "output.txt" : `example-${name}`,
    ]),
  );
  return {
    operationId,
    method,
    path,
    summary,
    pathParams,
    pathParameters: pathParams.map((name) =>
      field(
        name,
        name === "scope" ? '"task"|"project"|"global"' : "string",
        name === "key"
          ? "Memory key: ^[a-z0-9][a-z0-9._-]{0,63}$."
          : name === "path"
            ? "Artifact ID/path; slash-separated segments are independently encoded."
            : `Required ${name}; supplied as an unescaped value and encoded by the gateway.`,
        true,
      ),
    ),
    maxBodyBytes: [
      "spawn_session",
      "spawn_background_session",
      "spawn_shepherd",
      "send_message",
      "respawn_session",
    ].includes(operationId)
      ? 15_000_000
      : 1_000_000,
    ...(options.catchAllPathParams ? { catchAllPathParams: options.catchAllPathParams } : {}),
    query: options.query ?? [],
    body: options.body ?? null,
    responses: [
      {
        status: options.status ?? 200,
        contentType:
          operationId === "get_artifact"
            ? "application/octet-stream (stored MIME)"
            : "application/json",
        description:
          options.response ?? "Daemon operation result; response is forwarded without projection.",
      },
      {
        status: 400,
        contentType: "application/json",
        description: "Invalid request; error contains daemon message/code.",
      },
      {
        status: 404,
        contentType: "application/json",
        description: "Referenced resource does not exist.",
      },
      {
        status: 409,
        contentType: "application/json",
        description:
          "State/lifecycle conflict; includes operation receipt or available actions when provided.",
      },
      {
        status: 403,
        contentType: "application/json",
        description: "Actor or issued-handle authorization rejected; error body retained.",
      },
      {
        status: 429,
        contentType: "application/json",
        description: "Provider/session rate limit; daemon message and retry-after header retained.",
      },
      {
        status: 502,
        contentType: "application/json",
        description: "Upstream runtime or retained-pane probe failed.",
      },
      {
        status: 500,
        contentType: "application/json",
        description: "Daemon operation failed; error body retained.",
      },
      {
        status: 503,
        contentType: "application/json",
        description: "Daemon starting or upstream dependency unavailable.",
      },
    ],
    examples: (options.examples ?? [{}]).map((example) => ({
      ...(pathParams.length ? { pathParams: examplePathParams } : {}),
      ...example,
    })),
    sources: ["v2/src/server.ts", options.source ?? "v2/src/types.ts"],
  };
}

/** Every concrete daemon route, including discriminator alternatives. */
export const DAEMON_OPERATIONS: readonly DaemonOperation[] = [
  operation(
    "get_info",
    "GET",
    "/info",
    "Daemon identity, API/build version and runtime configuration.",
    { response: "RuntimeInfo" },
  ),
  operation("get_headroom", "GET", "/headroom", "Host/session admission capacity."),
  operation(
    "list_deploy_versions",
    "GET",
    "/deploy/versions",
    "Installed version, published releases and update policy.",
  ),
  operation(
    "get_deploy_status",
    "GET",
    "/deploy/switch/status",
    "Version-switch progress and outcome.",
  ),
  operation(
    "switch_deploy_version",
    "POST",
    "/deploy/switch",
    "Switch installed npm version; source checkouts refuse.",
    {
      body: body("DeploySwitchRequest", [
        field("version", "string", "Published nondeprecated release semver.", true),
      ]),
      examples: [{ body: { version: "1.0.0" } }],
      status: 202,
    },
  ),
  operation("set_auto_update", "POST", "/deploy/auto-update", "Set automatic update policy.", {
    body: body("AutoUpdateRequest", [
      field("enabled", "boolean", "Enable automatic updates.", true),
    ]),
    examples: [{ body: { enabled: false } }],
  }),
  operation(
    "list_claude_accounts",
    "GET",
    "/claude-accounts",
    "Claude account summaries; credentials excluded.",
  ),
  operation(
    "add_claude_account",
    "POST",
    "/claude-accounts/add",
    "Create account and start interactive login.",
    {
      body: body("AddAccountRequest", [field("label", "string", "Optional account label.")]),
      examples: [{ body: { label: "Work" } }],
      status: 201,
    },
  ),
  operation(
    "remove_claude_account",
    "POST",
    "/claude-accounts/remove",
    "Remove account; in-use accounts conflict.",
    {
      body: body("RemoveAccountRequest", [field("id", "string", "Nonblank account ID.", true)]),
      examples: [{ body: { id: "example-account" } }],
    },
  ),
  operation(
    "finish_claude_login",
    "POST",
    "/claude-accounts/{accountId}/finish-login",
    "Finish interactive account login.",
  ),
  operation(
    "get_claude_login_status",
    "GET",
    "/claude-accounts/{accountId}/login-status",
    "Read interactive login progress.",
  ),
  operation(
    "list_sessions",
    "GET",
    "/sessions",
    "List sessions including shepherd and unconfigured projects.",
    {
      query: [
        field(
          "includeCompleted",
          "boolean-string",
          "1 or true includes completed sessions.",
          false,
          false,
        ),
        field("view", '"full"|"dashboard"', "Session detail projection.", false, "full"),
      ],
      examples: [{ query: { includeCompleted: "true", view: "full" } }],
      response: "SessionListView[]; x-spur-lifecycle-instance-id header",
    },
  ),
  operation(
    "list_projects",
    "GET",
    "/projects",
    "List every configured, unconfigured and shepherd project.",
    { response: "ProjectListEntry[]" },
  ),
  operation("list_backlog", "GET", "/backlog/available", "List available backlog work."),
  operation("list_models", "GET", "/models", "Discover provider model catalog.", {
    query: [{ ...agent, required: true }],
    examples: [{ query: { agent: "codex" } }],
  }),
  operation("create_project", "POST", "/projects", "Create an unconfigured project.", {
    body: requestBodies.createProject,
    examples: [
      { body: { displayName: "Example", prefix: "ex", path: "~/example", createMissing: true } },
    ],
    status: 201,
    response: "CreateProjectResponse",
  }),
  operation(
    "update_project",
    "PATCH",
    "/projects/{projectId}",
    "Update unconfigured project name, prefix and path.",
    {
      body: requestBodies.updateProject,
      examples: [{ body: { displayName: "Example", prefix: "ex", path: "~/example" } }],
    },
  ),
  operation(
    "delete_project",
    "DELETE",
    "/projects/{projectId}",
    "Delete unconfigured project or disconnect configured project.",
  ),
  operation(
    "connect_project",
    "POST",
    "/projects/connect",
    "Connect project config and reload automation.",
    {
      body: body("ConnectProjectConfigRequest", [project]),
      examples: [{ body: { configPath: "~/example/spur.yaml" } }],
    },
  ),
  operation(
    "disconnect_project",
    "POST",
    "/projects/disconnect",
    "Disconnect project config and reload automation.",
    {
      body: body("DisconnectProjectConfigRequest", [project]),
      examples: [{ body: { configPath: "~/example/spur.yaml" } }],
    },
  ),
  operation(
    "create_preflight_batch",
    "POST",
    "/projects/{projectId}/preflight-batches",
    "Create project preflight batch.",
  ),
  operation(
    "preflight_project",
    "POST",
    "/projects/{projectId}/preflight",
    "Run task preflight for path project.",
    {
      body: requestBodies.preflight,
      examples: [{ body: { prompt: "Inspect the task", agent: "codex" } }],
      response: "PreflightResponse",
    },
  ),
  operation(
    "list_project_commands",
    "GET",
    "/projects/{projectId}/slash-commands",
    "Discover project slash commands.",
    { query: [agent], examples: [{ query: { agent: "codex" } }] },
  ),
  operation(
    "get_spawn_defaults",
    "GET",
    "/projects/{projectId}/spawn-defaults",
    "Resolve model, effort and workspace defaults.",
    {
      query: [{ ...agent, required: true }],
      examples: [{ query: { agent: "codex" } }],
      response: "SpawnDefaultsResponse",
    },
  ),
  operation(
    "get_branch_status",
    "GET",
    "/projects/{projectId}/branches/exists",
    "Check local/remote branch and checkout.",
    {
      query: [field("name", "string", "Branch name.", true)],
      examples: [{ query: { name: "feature/example" } }],
      response: "BranchExistsResponse",
    },
  ),
  operation(
    "get_session",
    "GET",
    "/sessions/{sessionId}",
    "Read complete session state, lifecycle, services and artifacts.",
    { response: "SessionView" },
  ),
  operation(
    "list_session_memory",
    "GET",
    "/sessions/{sessionId}/session-memory",
    "List task session-memory records.",
  ),
  operation(
    "resolve_session_memory",
    "POST",
    "/sessions/{sessionId}/session-memory/{key}/resolve",
    "Resolve session-memory record.",
  ),
  operation(
    "get_session_memory",
    "GET",
    "/sessions/{sessionId}/session-memory/{key}",
    "Read session-memory record.",
  ),
  operation(
    "set_session_memory",
    "POST",
    "/sessions/{sessionId}/session-memory/{key}",
    "Write session-memory note.",
    {
      body: body("SessionMemoryWrite", [
        field("body", "string", "Note content.", true),
        field("kind", '"note"', "Record kind.", false, "note"),
        field(
          "tags",
          "string[]",
          "Lowercase labels matching ^[a-z0-9][a-z0-9._-]{0,63}$; duplicates removed.",
        ),
      ]),
      examples: [{ body: { body: "Decision", kind: "note", tags: ["design"] } }],
      source: "v2/src/session-service.ts",
    },
  ),
  operation(
    "list_shared_memory",
    "GET",
    "/sessions/{sessionId}/shared-memory/{scope}",
    "List shared memory keys; scope task, project or global.",
  ),
  operation(
    "get_shared_memory",
    "GET",
    "/sessions/{sessionId}/shared-memory/{scope}/{key}",
    "Read shared memory entry; scope task, project or global.",
  ),
  operation(
    "set_shared_memory",
    "POST",
    "/sessions/{sessionId}/shared-memory/{scope}/{key}",
    "Write shared memory entry; scope task, project or global.",
    {
      body: body("SharedMemoryWrite", [field("body", "string", "Memory content.", true)]),
      examples: [{ body: { body: "Decision" } }],
      source: "v2/src/session-service.ts",
    },
  ),
  operation(
    "remove_shared_memory",
    "DELETE",
    "/sessions/{sessionId}/shared-memory/{scope}/{key}",
    "Remove shared memory entry; scope task, project or global.",
  ),
  operation(
    "get_session_logs",
    "GET",
    "/sessions/{sessionId}/logs",
    "Read retained runtime/service/sidecar logs.",
    {
      query: [
        field("scope", '"all"|"runtime"|"service"|"sidecar"', "Log scope."),
        field("name", "string", "Service or sidecar name."),
        limit,
      ],
      examples: [{ query: { scope: "all", limit: "200" } }],
      response: "SpurLogEntry[]; retained-pane failure may return 502",
    },
  ),
  operation(
    "get_session_actions",
    "GET",
    "/sessions/{sessionId}/user-actions",
    "Read session operator action log.",
    { query: [limit], examples: [{ query: { limit: "200" } }] },
  ),
  operation("get_user_actions", "GET", "/user-actions", "Read global operator action log.", {
    query: [limit],
    examples: [{ query: { limit: "200" } }],
  }),
  operation(
    "get_conversation",
    "GET",
    "/sessions/{sessionId}/conversation",
    "Read raw structured conversation including tools/reasoning/questions; optional message projection.",
    {
      query: [
        field("from", "integer", "Structured conversation entry cursor."),
        field("view", '"messages"', "Omit for complete raw history."),
        field(
          "limit",
          "integer 1..100",
          "Message projection page size; ignored in raw mode.",
          false,
          50,
        ),
      ],
      examples: [{}, { query: { from: "0", view: "messages", limit: "50" } }],
      response: "ConversationHistory | ConversationPage",
    },
  ),
  operation(
    "list_session_commands",
    "GET",
    "/sessions/{sessionId}/slash-commands",
    "Discover session slash commands.",
  ),
  operation(
    "list_subscriptions",
    "GET",
    "/sessions/{sessionId}/subscriptions",
    "Read session state subscriptions.",
  ),
  operation(
    "subscribe_session_states",
    "POST",
    "/sessions/{sessionId}/subscriptions",
    "Subscribe recipient to another session's state changes.",
    {
      body: requestBodies.subscription,
      examples: [
        { body: { targetSessionId: "example-target", states: ["waiting", "needs_input"] } },
      ],
    },
  ),
  operation(
    "remove_subscription",
    "POST",
    "/sessions/{sessionId}/subscriptions/{subscriptionId}/remove",
    "Remove session state subscription.",
  ),
  operation(
    "list_auto_ping_suppressions",
    "GET",
    "/sessions/{sessionId}/auto-ping-suppressions",
    "Read automatic ping suppressions.",
  ),
  operation(
    "unsubscribe_auto_ping",
    "POST",
    "/sessions/{sessionId}/auto-ping-suppressions/unsubscribe",
    "Suppress automatic ping delivery using issued handle.",
    {
      body: body("AutoPingUnsubscribe", [
        field("scope", '"event"|"thread"|"subscription"', "Handle scope.", true),
        field("handle", "string", "Opaque issued session credential.", true),
      ]),
      examples: [
        { body: { scope: "event", handle: "issued-event-handle" } },
        { body: { scope: "thread", handle: "issued-thread-handle" } },
        { body: { scope: "subscription", handle: "issued-subscription-handle" } },
      ],
    },
  ),
  operation(
    "resume_auto_ping",
    "POST",
    "/sessions/{sessionId}/auto-ping-suppressions/{suppressionId}/resume",
    "Resume suppressed automatic pings; body must be empty object.",
    { body: body("EmptyObject", []), examples: [{ body: {} }] },
  ),
  operation(
    "get_artifact",
    "GET",
    "/sessions/{sessionId}/artifacts/{path}",
    "Read retained artifact bytes with original MIME and disposition.",
    {
      catchAllPathParams: ["path"],
      response:
        "Binary artifact stream; path is artifact-relative and may contain slash-separated segments.",
    },
  ),
  operation(
    "spawn_session",
    "POST",
    "/sessions",
    "Spawn session interactively; all provider/workspace/task fields supported.",
    {
      body: spawn,
      examples: [
        {
          body: {
            project: "example-project",
            prompt: "Inspect code",
            agent: "codex",
            planMode: true,
          },
        },
      ],
      status: 201,
      response: "SessionView",
    },
  ),
  operation(
    "spawn_background_session",
    "POST",
    "/sessions/background",
    "Spawn session in background; same complete spawn contract.",
    {
      body: spawn,
      examples: [{ body: { project: "example-project", prompt: "Inspect code", agent: "codex" } }],
      status: 201,
      response: "SessionView",
    },
  ),
  operation("spawn_shepherd", "POST", "/shepherd/spawn", "Spawn or reuse shepherd session.", {
    body: body("ShepherdSpawnRequest", [
      field("prompt", "string", "Task prompt override."),
      field("reportDisposition", "boolean", "Return disposition plus session.", false, false),
    ]),
    examples: [{ body: { prompt: "Inspect work", reportDisposition: true } }],
    status: 201,
  }),
  operation(
    "send_message",
    "POST",
    "/sessions/{sessionId}/send",
    "Send task/message with full queue, interrupt and attachment options.",
    {
      body: send,
      examples: [
        { body: { message: "Continue", queue: true } },
        {
          body: {
            message: "Inspect file",
            attachments: [{ name: "input.txt", data: "aGVsbG8=" }],
            interrupt: true,
          },
        },
      ],
    },
  ),
  operation(
    "remove_queued_message",
    "POST",
    "/sessions/{sessionId}/queue/remove",
    "Remove queued message by trimmed text.",
    {
      body: body("QueueMessageRequest", [
        field("message", "string", "Nonblank queued message text, trimmed before lookup.", true),
      ]),
      examples: [{ body: { message: "Continue" } }],
    },
  ),
  operation(
    "flush_queued_message",
    "POST",
    "/sessions/{sessionId}/queue/flush",
    "Deliver queued message by trimmed text.",
    {
      body: body("QueueMessageRequest", [
        field("message", "string", "Nonblank queued message text, trimmed before lookup.", true),
      ]),
      examples: [{ body: { message: "Continue" } }],
    },
  ),
  operation(
    "answer_question",
    "POST",
    "/sessions/{sessionId}/answer",
    "Choose provider question option.",
    {
      body: body("AnswerQuestionRequest", [
        field("optionIndex", "nonnegative integer", "Zero-based option index.", true),
      ]),
      examples: [{ body: { optionIndex: 0 } }],
    },
  ),
  operation(
    "submit_launch",
    "POST",
    "/sessions/{sessionId}/launch/submit",
    "Submit pending launch prompt.",
  ),
  operation(
    "retry_submit",
    "POST",
    "/sessions/{sessionId}/submit-failed/retry",
    "Retry failed prompt submission.",
  ),
  operation(
    "dismiss_submit",
    "POST",
    "/sessions/{sessionId}/submit-failed/dismiss",
    "Dismiss failed prompt submission.",
  ),
  operation(
    "reply_to_source",
    "POST",
    "/sessions/{sessionId}/source-reply",
    "Send reply and optional choices in assigned Telegram forum topic.",
    {
      body: body("SourceReplyRequest", [
        field(
          "message",
          "string",
          "Nonblank text; nonterminal session and configured Telegram forum required.",
          true,
        ),
        field(
          "buttons",
          "{text:string,value:string}[]",
          "At most 8 buttons; unique trimmed text 1..64 characters, trimmed value 1..200 characters.",
        ),
        field(
          "requestInterfaceApproval",
          '{version:1,repository:string,baseBranch:string,surfaces:{kind:"UI"|"CLI"|"config"|"API"|"prompt"|"workflow",id:string,before:string[],after:string[],constraints:string[]}[]}',
          "InterfaceManifest; excludes buttons. Nonblank clauses, unique kind/id surfaces; repository/base/source must match native approval policy. Requesting approval never grants it.",
        ),
      ]),
      examples: [
        { body: { message: "Choose", buttons: [{ text: "Continue", value: "continue" }] } },
        {
          body: {
            message: "Approve interface",
            requestInterfaceApproval: {
              version: 1,
              repository: "example/repo",
              baseBranch: "main",
              surfaces: [
                {
                  kind: "API",
                  id: "example",
                  before: [],
                  after: ["Expose operation"],
                  constraints: ["Loopback only"],
                },
              ],
            },
          },
        },
      ],
      response: "SourceReplyResponse",
    },
  ),
  operation(
    "get_source_info",
    "GET",
    "/sessions/{sessionId}/source-info",
    "Read existing canonical Telegram topic and cached bot identity without allocating.",
    { response: "SourceInfoResponse; source:null without an eligible assigned topic." },
  ),
  operation(
    "enable_source_poll",
    "POST",
    "/sessions/{sessionId}/source-poll-enable",
    "Clear source polling suppression for session.",
  ),
  operation(
    "wake_session",
    "POST",
    "/sessions/{sessionId}/wake",
    "Schedule, update or dispatch structured wake.",
    {
      body: requestBodies.wake,
      examples: [
        { body: { delayMs: 60000, message: "Continue" } },
        { body: { at: "2099-01-01T00:00:00.000Z", message: "Continue" } },
        { body: { intervalMs: 60000, stopCondition: "Task complete", message: "Continue" } },
        { body: { dailyAt: ["09:00"], stopCondition: "Task complete", message: "Continue" } },
        { body: { target: "interval", message: "Updated reminder" } },
        { body: { target: "scheduled", dispatch: true } },
      ],
    },
  ),
  operation(
    "cancel_wake",
    "POST",
    "/sessions/{sessionId}/wake/cancel",
    "Cancel scheduled/repeating wakes.",
  ),
  operation(
    "mark_session_opened",
    "POST",
    "/sessions/{sessionId}/opened",
    "Mark session as opened.",
  ),
  operation("pause_session", "POST", "/sessions/{sessionId}/pause", "Pause session."),
  operation(
    "get_todo",
    "GET",
    "/sessions/{sessionId}/todo",
    "Read authoritative session task ledger.",
  ),
  operation(
    "mutate_todo",
    "POST",
    "/sessions/{sessionId}/todo",
    "Add, finish, cancel, hold or resume task ledger item.",
    {
      body: requestBodies.todo,
      examples: [
        { body: { action: "add", text: "Inspect code", reason: "Task" } },
        { body: { action: "complete", itemId: "example-item", reason: "Verified" } },
        { body: { action: "cancel", itemId: "example-item", reason: "Superseded" } },
        {
          body: {
            action: "hold",
            itemId: "example-item",
            reason: "Await access",
            blocker: "human",
            requiredHumanAction: "Grant access",
          },
        },
        {
          body: {
            action: "hold",
            itemId: "example-item",
            reason: "Await dependency",
            blocker: "external",
          },
        },
        { body: { action: "resume", itemId: "example-item" } },
      ],
    },
  ),
  operation(
    "complete_session",
    "POST",
    "/sessions/{sessionId}/complete",
    "Complete session or desk with explicit PR disposition and owned Telegram topic cleanup.",
    {
      body: requestBodies.complete,
      examples: [
        { body: { scope: "session", prAction: "leave_open" } },
        { body: { scope: "desk", prAction: "leave_open" } },
      ],
    },
  ),
  operation(
    "self_destruct_session",
    "POST",
    "/sessions/{sessionId}/self-destruct",
    "Perform session self-destruction.",
  ),
  operation(
    "kill_session",
    "POST",
    "/sessions/{sessionId}/kill",
    "Terminate session runtime and attempt owned Telegram topic deletion.",
    {
      body: requestBodies.kill,
      examples: [{ body: { force: true, prAction: "leave_open" } }],
    },
  ),
  operation(
    "restore_session",
    "POST",
    "/sessions/{sessionId}/restore",
    "Restore stopped session runtime.",
    { body: restore, examples: [{ body: { force: false, overrideTokenBudget: false } }] },
  ),
  operation("reopen_session", "POST", "/sessions/{sessionId}/reopen", "Reopen completed session.", {
    body: restore,
    examples: [{ body: { force: false } }],
  }),
  operation(
    "handoff_session",
    "POST",
    "/sessions/{sessionId}/handoff",
    "Hand task to another provider.",
    {
      body: requestBodies.handoff,
      examples: [{ body: { agent: "codex", notes: "Continue task" } }],
    },
  ),
  operation(
    "respawn_session",
    "POST",
    "/sessions/{sessionId}/respawn",
    "Create replacement session with provider and attachment options.",
    {
      body: requestBodies.respawn,
      examples: [{ body: { prompt: "Continue", agent: "codex", forceKillSource: false } }],
    },
  ),
  operation(
    "switch_session_auth",
    "POST",
    "/sessions/{sessionId}/switch-auth",
    "Switch Claude account for session.",
    {
      body: body("SwitchAuthRequest", [
        field("accountId", "string", "Nonblank account ID.", true),
        field("force", "boolean", "Force account switch.", false, false),
      ]),
      examples: [{ body: { accountId: "example-account", force: false } }],
    },
  ),
  operation(
    "update_session_slots",
    "POST",
    "/sessions/{sessionId}/slots",
    "Update title, links and tags.",
    {
      body: requestBodies.slots,
      examples: [
        {
          body: {
            title: "Inspect task",
            source: "agent",
            links: [{ label: "pr", url: "https://github.com/example/repo/pull/1" }],
            tags: ["feature"],
          },
        },
      ],
    },
  ),
  operation(
    "start_sidecar",
    "POST",
    "/sessions/{sessionId}/sidecars/{sidecarName}/start",
    "Start configured sidecar.",
    {
      body: body("StartSidecarRequest", [
        field("callerSidecarName", "string", "Parent sidecar name for nested start."),
        field("callerSidecarDepth", "number", "Parent sidecar nesting depth."),
        field("clearPort", "integer", "Explicit occupied port to clear; ownership rules apply."),
      ]),
      examples: [{ body: {} }],
    },
  ),
  operation(
    "stop_sidecar",
    "POST",
    "/sessions/{sessionId}/sidecars/{sidecarName}/stop",
    "Stop configured sidecar.",
  ),
  operation(
    "sweep_sidecars",
    "POST",
    "/sidecars/sweep",
    "Inspect or reap leaked sidecar processes.",
    {
      body: body("SweepSidecarsRequest", [
        field("reap", "boolean", "Kill eligible leaked processes.", false, false),
      ]),
      examples: [{ body: { reap: false } }, { body: { reap: true } }],
    },
  ),
  operation("list_services", "GET", "/sessions/{sessionId}/services", "List session services."),
  operation(
    "get_service",
    "GET",
    "/sessions/{sessionId}/services/{serviceId}",
    "Read service state.",
  ),
  operation(
    "run_service",
    "POST",
    "/sessions/{sessionId}/services/{serviceId}/run",
    "Run session service command.",
    {
      body: body("RunServiceRequest", [
        field("command", "string", "Command to run.", true),
        field("cwd", "string", "Working directory.", true),
        field("port", "number", "Service port override."),
      ]),
      examples: [{ body: { command: "pnpm dev", cwd: "." } }],
    },
  ),
];

export function getDaemonOperation(operationId: string): DaemonOperation | undefined {
  return DAEMON_OPERATIONS.find((entry) => entry.operationId === operationId);
}

export type DaemonOperationSummary = Pick<
  DaemonOperation,
  "operationId" | "method" | "path" | "summary"
>;
interface OperationDescription<T> {
  operations: readonly T[];
  total: number;
  nextOffset?: number;
}
interface DescribeOptions {
  operationId?: string;
  offset?: number;
  limit?: number;
}
export function describeDaemonOperations(options: {
  operationId: string;
}): OperationDescription<DaemonOperation>;
export function describeDaemonOperations(options?: {
  offset?: number;
  limit?: number;
}): OperationDescription<DaemonOperationSummary>;
export function describeDaemonOperations(
  options: DescribeOptions,
): OperationDescription<DaemonOperation | DaemonOperationSummary>;
export function describeDaemonOperations(
  options: DescribeOptions = {},
): OperationDescription<DaemonOperation | DaemonOperationSummary> {
  if (options.operationId !== undefined) {
    const entry = getDaemonOperation(options.operationId);
    if (!entry) throw new Error(`Unknown daemon operation: ${options.operationId}`);
    return { operations: [entry], total: 1 };
  }
  const offset = options.offset ?? 0;
  const pageLimit = options.limit ?? 20;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(pageLimit) ||
    pageLimit < 1 ||
    pageLimit > 50
  ) {
    throw new Error(
      "Operation offset must be a nonnegative integer and limit an integer from 1 to 50",
    );
  }
  const nextOffset = offset + pageLimit;
  return {
    operations: DAEMON_OPERATIONS.slice(offset, nextOffset).map(
      ({ operationId, method, path, summary }) => ({ operationId, method, path, summary }),
    ),
    total: DAEMON_OPERATIONS.length,
    ...(nextOffset < DAEMON_OPERATIONS.length ? { nextOffset } : {}),
  };
}

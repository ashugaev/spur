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
const storeData = field("data", "object", "Document JSON object, at most 262144 bytes.", true);
const storeExpectedRev = field(
  "expectedRev",
  "integer",
  "Write only at this revision; 0 = absent.",
);
const storeLimit = field("limit", "integer 1..500", "Page size.", false, 100);
const pageSummaryResponse =
  'PageSummary {id,title,icon?,agent,path,url,source?:{path:string},sync?:{state:"pending"|"syncing"|"synced"|"error",root?:string,lastSyncedAt?:string,error?:string}}. Sync appears only for sourced Pages; lastSyncedAt is the last successful reconciliation ISO time and is retained on errors; error appears only in error state.';
const storeTooLarge: ContractResponse = {
  status: 413,
  contentType: "application/json",
  description: "Document over 262144 bytes or store file over 64 MiB.",
};
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
  field(
    "allowedTriggers",
    "string[]",
    "Allowed send trigger IDs. Omit to allow all; [] blocks every send trigger, including CI failure alerts. Carried by respawn and handoff.",
  ),
  field("branch", "string", "Workspace branch; project naming constraints apply."),
  field(
    "prAlertOwner",
    "boolean",
    "Opt into exclusive native PR CI and conflict alerts; requires an allowed send route for each class.",
  ),
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
  field("authAccountId", "string|null", "Saved provider account; omitted/null uses Auto."),
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
    "restart",
    "boolean",
    "Restart a running terminal session; restore endpoint only.",
    false,
    false,
  ),
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
const cronJobIdentity = [
  field("project", "string", "Existing project ID.", true),
  field("source", "string", "Existing Cron source ID.", true),
  field("trigger", "string", "Existing spawn trigger bound to the source.", true),
];
const cronJobValidation: readonly ContractResponse[] = [
  {
    status: 422,
    contentType: "application/json",
    description:
      "Invalid config/schedule/block or unsupported YAML/action; error, code and optional field.",
  },
];
const cronJobUpdate: ContractBody = {
  ...body("CronJobEditUpdate", [
    field("revision", "string", "64 lowercase SHA256 hex characters from the disk draft.", true),
    field("schedule", "string", "Cron schedule shared by all triggers on this source.", true),
    field(
      "blocks",
      "CronJobEditBlock[]",
      "Existing block order/count; all properties required; null clears an override.",
      true,
    ),
  ]),
  definitions: `interface CronJobEditBlock { prompt: string; agent: ${agent.type}|null; model: string|null; reasoningEffort: ${effort.type}|null; }`,
};
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
  extraResponses?: readonly ContractResponse[];
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
      "reply_to_source",
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
      ...(options.extraResponses ?? []),
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
    "list_auth_accounts",
    "GET",
    "/auth-accounts",
    "Saved provider authorization accounts and pools.",
    {
      query: [field("agent", '"claude"|"codex"', "Optional provider filter.")],
    },
  ),
  operation(
    "add_auth_account",
    "POST",
    "/auth-accounts",
    "Create a saved provider authorization account.",
    {
      body: body("AddAuthAccountRequest", [
        field("provider", '"claude"|"codex"', "Provider.", true),
        field("label", "string", "Display label."),
      ]),
      examples: [{ body: { provider: "codex", label: "Work" } }],
    },
  ),
  operation(
    "rename_auth_account",
    "PATCH",
    "/auth-accounts/{accountId}",
    "Rename an authorization account.",
    {
      body: body("RenameAuthAccountRequest", [field("label", "string", "Display label.", true)]),
      examples: [{ body: { label: "Work" } }],
    },
  ),
  operation(
    "remove_auth_account",
    "DELETE",
    "/auth-accounts/{accountId}",
    "Remove an unused authorization account.",
  ),
  operation(
    "login_auth_account",
    "POST",
    "/auth-accounts/{accountId}/login",
    "Start provider OAuth sign-in.",
  ),
  operation(
    "get_auth_account_login",
    "GET",
    "/auth-accounts/{accountId}/login-status",
    "Read OAuth readiness and sign-in instructions.",
  ),
  operation(
    "submit_auth_account_login",
    "POST",
    "/auth-accounts/{accountId}/login-input",
    "Submit a sign-in code or cancel login.",
    {
      body: body("AuthAccountLoginInput", [
        field("input", "string", "Authorization code; excludes cancel."),
        field("cancel", "boolean", "Cancel active login; excludes input."),
      ]),
      examples: [{ body: { input: "authorization-code" } }, { body: { cancel: true } }],
    },
  ),
  operation(
    "update_auth_pool",
    "PATCH",
    "/auth-pools/{provider}",
    "Update provider-wide default and quota rotation.",
    {
      body: body("UpdateAuthPoolRequest", [
        field("defaultAccountId", "string|null", "Ready default account."),
        field("autoRotate", "boolean", "Rotate Auto sessions on quota."),
      ]),
    },
  ),
  operation(
    "get_usage",
    "GET",
    "/usage",
    "Provider quota windows and session token totals; tokens excluded.",
  ),
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
  operation(
    "list_cron_jobs",
    "GET",
    "/projects/cron",
    "List loaded cron sources, bound triggers, owner-file drift and last observed events.",
    {
      query: [field("project", "string", "Project id; omit for all projects.", false)],
      examples: [{}, { query: { project: "example-project" } }],
      response: "CronJobsResponse",
    },
  ),
  operation(
    "get_cron_job_draft",
    "GET",
    "/projects/cron/edit",
    "Read the selected Cron spawn job's raw YAML draft and revision.",
    {
      query: cronJobIdentity,
      examples: [{ query: { project: "example-project", source: "nightly", trigger: "audit" } }],
      response:
        "CronJobEditDraft; selected disk values, owner, revision and shared-source trigger IDs.",
      source: "v2/src/cron-job-editor.ts",
      extraResponses: cronJobValidation,
    },
  ),
  operation(
    "save_cron_job_draft",
    "PATCH",
    "/projects/cron/edit",
    "Save validated Cron spawn settings to YAML without applying runtime changes.",
    {
      query: cronJobIdentity,
      body: cronJobUpdate,
      examples: [
        {
          query: { project: "example-project", source: "nightly", trigger: "audit" },
          body: {
            revision: "a".repeat(64),
            schedule: "0 4 * * *",
            blocks: [
              {
                prompt: "Inspect scheduled tasks",
                agent: null,
                model: null,
                reasoningEffort: null,
              },
            ],
          },
        },
      ],
      response: 'CronJobEditResult; saved:true, activation:"pending"; no runtime reload.',
      source: "v2/src/cron-job-editor.ts",
      extraResponses: cronJobValidation,
    },
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
    "Read active automatic ping mutes; all=1 adds the session's mute history.",
    {
      query: [field("all", '"1"', "Include per-session mute history.", false)],
      examples: [{}, { query: { all: "1" } }],
    },
  ),
  operation(
    "mute_auto_ping",
    "POST",
    "/sessions/{sessionId}/auto-ping-suppressions/mute",
    "Mute automatic pings using the issued handle.",
    {
      body: body("AutoPingMute", [
        field("handle", "string", "Opaque issued session credential.", true),
        field("mode", '"until_change"|"for"|"forever"', "Mute mode.", true),
        field("durationMs", "number", "Mode for only: 60000 to 86400000.", false),
        field("reason", "string", "Required for for and forever.", false),
      ]),
      examples: [
        { body: { handle: "issued-handle", mode: "until_change" } },
        { body: { handle: "issued-handle", mode: "for", durationMs: 7200000, reason: "waiting" } },
        { body: { handle: "issued-handle", mode: "forever", reason: "wrong trigger" } },
      ],
    },
  ),
  operation(
    "resume_auto_ping",
    "POST",
    "/sessions/{sessionId}/auto-ping-suppressions/resume",
    "Resume muted automatic pings by handle or mute id.",
    {
      body: body("AutoPingResume", [
        field("handle", "string", "Issued handle; exclusive with suppressionId.", false),
        field("suppressionId", "string", "Mute id; exclusive with handle.", false),
      ]),
      examples: [{ body: { handle: "issued-handle" } }, { body: { suppressionId: "mute-id" } }],
    },
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
      response:
        "SessionView; under resource admission pressure, accepts a spawning identity before launch. Healthy foreground requests wait for launch.",
    },
  ),
  operation(
    "spawn_background_session",
    "POST",
    "/sessions/background",
    "Spawn session in background; accepts identity before resource recovery and launch.",
    {
      body: spawn,
      examples: [{ body: { project: "example-project", prompt: "Inspect code", agent: "codex" } }],
      status: 201,
      response:
        "SessionView with accepted spawning identity; durable launch intent retains that identity across daemon restart. Uncertain runtime ownership remains held.",
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
        field(
          "images",
          "{name:string,data:string}[]",
          "At most 4 base64 PNG/JPEG/WebP files named .png/.jpg/.jpeg/.webp, 10000000 decoded bytes total; each width+height at most 10000, side ratio at most 20. Sent as photos before the text.",
        ),
      ]),
      examples: [
        { body: { message: "Choose", buttons: [{ text: "Continue", value: "continue" }] } },
        {
          body: {
            message: "Screenshot",
            images: [
              {
                name: "shot.png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
              },
            ],
          },
        },
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
    "Select managed authorization for the next request without restarting the agent.",
    {
      body: body("SwitchAuthRequest", [
        field("accountId", "string|null", "Saved account ID or null for Auto.", true),
      ]),
      examples: [{ body: { accountId: "example-account" } }],
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
  operation(
    "list_store_docs",
    "GET",
    "/stores/{store}/docs/{collection}",
    "List store documents ordered by id; store is page:<id> or session:<sid>.",
    {
      query: [storeLimit, field("startAfter", "string", "Document id cursor.")],
      examples: [{ query: { limit: "20" } }],
      response: "{docs:StoreDoc[]}",
      source: "v2/src/stores.ts",
      extraResponses: [storeTooLarge],
    },
  ),
  operation(
    "add_store_doc",
    "POST",
    "/stores/{store}/docs/{collection}",
    "Add a document with a generated id; _actions rejected.",
    {
      body: body("StoreWriteRequest", [storeData]),
      examples: [{ body: { data: { title: "Dune" } } }],
      response: "StoreDoc",
      status: 201,
      source: "v2/src/stores.ts",
      extraResponses: [storeTooLarge],
    },
  ),
  operation(
    "get_store_doc",
    "GET",
    "/stores/{store}/docs/{collection}/{docId}",
    "Read one store document.",
    { response: "StoreDoc", source: "v2/src/stores.ts" },
  ),
  operation(
    "set_store_doc",
    "POST",
    "/stores/{store}/docs/{collection}/{docId}",
    "Create or replace a store document; expectedRev mismatch conflicts.",
    {
      body: body("StoreWriteRequest", [storeData, storeExpectedRev]),
      examples: [
        { body: { data: { title: "Dune" } } },
        { body: { data: { n: 1 }, expectedRev: 0 } },
      ],
      response: "StoreDoc",
      source: "v2/src/stores.ts",
      extraResponses: [storeTooLarge],
    },
  ),
  operation(
    "update_store_doc",
    "PATCH",
    "/stores/{store}/docs/{collection}/{docId}",
    "Merge-patch a store document (RFC 7386; null removes a key).",
    {
      body: body("StoreWriteRequest", [storeData, storeExpectedRev]),
      examples: [{ body: { data: { watched: true } } }],
      response: "StoreDoc",
      source: "v2/src/stores.ts",
      extraResponses: [storeTooLarge],
    },
  ),
  operation(
    "delete_store_doc",
    "DELETE",
    "/stores/{store}/docs/{collection}/{docId}",
    "Delete a store document.",
    {
      query: [field("expectedRev", "integer", "Delete only at this revision.")],
      response: "{deleted:true}",
      source: "v2/src/stores.ts",
    },
  ),
  operation(
    "query_store_docs",
    "POST",
    "/stores/{store}/query/{collection}",
    "Query store documents with where/orderBy/limit/startAfter.",
    {
      body: body("StoreQuery", [
        field(
          "where",
          '{field:string,op:"=="|"!="|"<"|"<="|">"|">="|"in"|"contains",value:unknown}[]',
          "At most 8 clauses; field is a dotted path into data.",
        ),
        field("orderBy", '{field:string,direction?:"asc"|"desc"}', "Sort field; ties by id."),
        storeLimit,
        field("startAfter", "string", "Document id cursor."),
      ]),
      examples: [{ body: { where: [{ field: "watched", op: "==", value: false }], limit: 20 } }],
      response: "{docs:StoreDoc[]}",
      source: "v2/src/stores.ts",
    },
  ),
  operation(
    "list_store_changes",
    "GET",
    "/stores/{store}/changes",
    "Read store change rows after a sequence cursor; reset:true means refetch.",
    {
      query: [
        field("since", "integer", "Last seen change seq.", false, 0),
        field("limit", "integer 1..500", "Page size.", false, 500),
      ],
      examples: [{ query: { since: "0" } }],
      response: "{changes:{seq,collection,id,op,rev}[],lastSeq:number,reset?:true}",
      source: "v2/src/stores.ts",
    },
  ),
  operation(
    "send_store_agent",
    "POST",
    "/stores/{store}/agent/send",
    "Queue a message to the store's agent; a page agent spawns or recovers on demand.",
    {
      body: body("StoreAgentSendRequest", [
        field("message", "string", "1..20000 characters.", true),
        field("userGesture", "boolean", "Sent from a trusted user click; resets loop budgets."),
      ]),
      examples: [{ body: { message: "Suggest three films" } }],
      response: "{sessionId:string}; 429 delivery budget, 503 page recovery budget.",
      source: "v2/src/store-agent.ts",
    },
  ),
  operation(
    "list_store_agent_messages",
    "GET",
    "/stores/{store}/agent/messages",
    "Visible messages of the store's agent session plus its status.",
    {
      query: [
        field("from", "integer", "Conversation entry cursor."),
        field("limit", "integer 1..100", "Page size.", false, 50),
      ],
      examples: [{ query: { limit: "20" } }],
      response:
        "ConversationPage & {status:{state,sessionId}} | {sessionId:null,messages:[],status}",
      source: "v2/src/store-agent.ts",
    },
  ),
  operation(
    "get_store_agent_status",
    "GET",
    "/stores/{store}/agent/status",
    "Store agent status: none|working|idle|recovering|error|rate_limited.",
    { response: "{state:string,sessionId:string|null}", source: "v2/src/store-agent.ts" },
  ),
  operation(
    "invoke_store_action",
    "POST",
    "/stores/{store}/actions",
    "Record an _actions doc and deliver [spur-action v1] to the store's agent once per id.",
    {
      body: body("InvokeActionRequest", [
        field(
          "id",
          "string",
          "Action id ^[A-Za-z0-9_-]{8,64}$; repeats return the existing doc.",
          true,
        ),
        field("action", "string", "Action name ^[a-z0-9][a-z0-9_-]{0,63}$.", true),
        field(
          "label",
          "string",
          "1..80 chars, no control/quote/backslash/bracket/bidi; default action.",
        ),
        field(
          "source",
          '{kind:"page"}|{kind:"snippet",snippetId,instanceId,revision}',
          "Origin.",
          true,
        ),
        field("payload", "object", "JSON object, at most 49152 bytes.", true),
        field("userGesture", "boolean", "Sent from a trusted user click."),
        field("retryOf", "string", "Id of a failed action this retries."),
      ]),
      examples: [
        {
          body: {
            id: "act-00000001",
            action: "pick",
            source: { kind: "page" },
            payload: { film: "Dune" },
          },
        },
      ],
      response:
        "StoreDoc (status pending); 409 closed store, 429 pending cap or budget, 503 recovery budget.",
      source: "v2/src/store-actions.ts",
    },
  ),
  operation(
    "complete_store_action",
    "POST",
    "/stores/{store}/actions/{actionId}/complete",
    "Close a pending action as done or failed; expired or closed actions conflict.",
    {
      body: body("CompleteActionRequest", [
        field("status", '"done"|"failed"', "Outcome.", true),
        field("result", "unknown", "JSON result for done."),
        field("error", "string", "1..2000 chars for failed."),
      ]),
      examples: [{ body: { status: "done", result: { ok: true } } }],
      response: "StoreDoc",
      source: "v2/src/store-actions.ts",
    },
  ),
  operation("list_pages", "GET", "/pages", "List pages with identity, source and sync status.", {
    response: `{pages:PageSummary[]}. ${pageSummaryResponse}`,
    source: "v2/src/pages.ts",
  }),
  operation(
    "create_page",
    "POST",
    "/pages",
    "Create a Page and attempt its optional source import before responding.",
    {
      body: body("CreatePageRequest", [
        field("id", "string", "Page id ^[a-z0-9][a-z0-9-]{0,39}$.", true),
        field("title", "string", "1..120 printable characters; defaults to id."),
        field(
          "runtime",
          '"claude"|"codex"|"cursor"|"opencode"',
          "Page agent runtime.",
          false,
          "claude",
        ),
        field("model", "string", "Page agent model."),
        field("template", '"blank"', "Starter files.", false, "blank"),
        field(
          "source",
          "{path:string}",
          "Absolute daemon-host HTML/folder path without control characters. HTML publishes its parent folder, including siblings.",
        ),
      ]),
      examples: [{ body: { id: "films", title: "Films" } }],
      response: `${pageSummaryResponse} Initial source attempt completes before response; inaccessible source returns sync:error.`,
      status: 201,
      source: "v2/src/pages.ts",
    },
  ),
  operation(
    "update_page_source",
    "PATCH",
    "/pages/{pageId}/source",
    "Update a Page source binding; detach retains publication and native SQL.",
    {
      body: body("object", [
        field(
          "path",
          "string|null",
          "Absolute daemon-host HTML/folder path without control characters; null detaches and retains publication/SQL. HTML publishes its parent folder, including siblings.",
          true,
        ),
      ]),
      examples: [{ body: { path: "/path/to/site" } }, { body: { path: null } }],
      response: `${pageSummaryResponse} Initial source attempt completes before response; inaccessible source returns sync:error. Detach removes source/sync.`,
      source: "v2/src/pages.ts",
    },
  ),
  operation(
    "delete_page",
    "DELETE",
    "/pages/{pageId}",
    "Delete a page dir, its store and streams.",
    {
      response: "{deleted:true,id:string}",
      source: "v2/src/pages.ts",
    },
  ),
  operation(
    "get_page_file",
    "GET",
    "/pages/{pageId}/files/{path}",
    "Serve one page file; dot paths, data.sqlite*, page.yaml and _spur are hidden at every depth. Native SDK routes remain available.",
    {
      catchAllPathParams: ["path"],
      response: "Raw file, PAGE_CONTENT_TYPES MIME, cache-control no-store.",
      source: "v2/src/pages.ts",
    },
  ),
  operation(
    "stream_page_events",
    "GET",
    "/pages/{pageId}/events",
    "Page event stream (text/event-stream): change, reset, reload, agent.",
    {
      query: [field("since", "integer", "Replay changes after this seq; Last-Event-ID wins.")],
      examples: [{ query: { since: "0" } }],
      response: "text/event-stream; non-SSE Accept 406; 64 open streams 503.",
      source: "v2/src/pages.ts",
      extraResponses: [
        {
          status: 406,
          contentType: "application/json",
          description: "Accept lacks text/event-stream.",
        },
      ],
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

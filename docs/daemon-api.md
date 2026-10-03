# Daemon HTTP API

> Scope: route names only, one method + full path per line, every line `git grep`-able verbatim. Payload/status-code contracts: `v2/src/server.ts`. CLI usage: [commands.md](commands.md). Default `127.0.0.1:4310`.

- `GET /info` — `lifecycleInstanceId`: process identity; `v2/src/session-lifecycle.ts`.
- `GET /headroom`
- `GET /models`
- `GET /user-actions`
- `GET /deploy/versions`
- `GET /deploy/switch/status`
- `POST /deploy/switch` — see [Auto update](configuration.md#auto-update)
- `POST /deploy/auto-update`
- `GET /claude-accounts`
- `POST /claude-accounts/add`
- `POST /claude-accounts/remove`
- `POST /claude-accounts/:id/finish-login`
- `GET /claude-accounts/:id/login-status`

## Project routes

- `GET /projects`
- `POST /projects`
- `PATCH /projects/:id`
- `DELETE /projects/:id`
- `POST /projects/connect`
- `POST /projects/disconnect`
- `GET /backlog/available`
- `GET /projects/:id/slash-commands`
- `GET /projects/:id/spawn-defaults?agent=<name>` — `{model, worktree}`
- `GET /projects/:id/branches/exists?name=<branch>`
- `POST /projects/:id/preflight-batches`
- `POST /projects/:id/preflight`

## Session routes

- `GET /sessions` — array body; producing `x-spur-lifecycle-instance-id` header, per-row `lifecycle`; `v2/src/session-lifecycle.ts`.
- `POST /sessions` — optional `reasoningEffort` overrides project default; provider/model validation in `v2/src/session-service.ts`.
- `POST /sessions/background`
- `POST /shepherd/spawn`
- `POST /sidecars/sweep` — body `{ reap?: boolean }`, default `false`. Always `200`. Response `{ supported, leaked, reaped }`: `supported` is `false` when the process table or procfs is unreadable, in which case `leaked` and `reaped` are both `[]`. Each `leaked` row carries `kind: "worktree-tree" | "orphan-daemon"`; a `worktree-tree` row's `reapable` reflects proven Spur provenance and carries `rootPid`, `pgid`, `ageSeconds`, `worktreePath`, `args`, `sidecarName`, `tree` (descendant pids, root first), `treeRssKb`; an `orphan-daemon` row is always `reapable: false` and carries `configPath`/`cliEntryPath` instead of a `sidecarName`, plus `port: number | null` and `liveness: "serving" | "not-serving" | "unknown"`. `reap: true` signals only `reapable` rows — never an `orphan-daemon` row, serving or not — and populates `reaped`, one entry per `reapable` leaked tree it signaled: `{ sessionName, panePid, survivors, blindKill }` — `survivors` is the pids still alive after the SIGKILL confirmation window, and `blindKill` is `true` when tmux was killed with no verified process-tree signal (no pane pid, or an unusable snapshot, and no identity fallback confirmed a reap either) — a `survivors: []` alongside `blindKill: true` is not proof anything died, only that nothing was checked. See [Sidecars](commands.md#sidecars)
- `GET /sessions/:id` — current row plus ephemeral `lifecycle` receipt; `v2/src/session-lifecycle.ts`.
- `GET /sessions/:id/slash-commands`
- `GET /sessions/:id/conversation`
- `GET /sessions/:id/user-actions`
- `GET /sessions/:id/subscriptions`
- `GET /sessions/:id/logs` — `?scope=runtime|sidecar|service|all`
- `POST /sessions/:id/send` — response `queuedAheadReason: "no_interrupt"`: queued at the head
- `POST /sessions/:id/answer`
- `POST /sessions/:id/launch/submit` — presses submit over a pending `submitUnconfirmedAt` prompt
- `POST /sessions/:id/submit-failed/retry` — re-queues `submitFailedMessage` at the head
- `POST /sessions/:id/submit-failed/dismiss` — drops `submitFailedMessage`
- `POST /sessions/:id/source-reply`
- `POST /sessions/:id/opened`
- `POST /sessions/:id/pause`
- `POST /sessions/:id/complete` — optional correlation `operationId`, group `completedIds`/outcomes, lifecycle 409/503; `v2/src/session-lifecycle.ts`, `v2/src/server.ts`.
- `POST /sessions/:id/self-destruct`
- `POST /sessions/:id/kill`
- `POST /sessions/:id/restore` — optional correlation `operationId`, settled receipt, lifecycle 409/503; `v2/src/session-lifecycle.ts`, `v2/src/server.ts`.
- `POST /sessions/:id/reopen` — restore request fields and single reopen receipt; `v2/src/session-lifecycle.ts`, `v2/src/server.ts`.
- `POST /sessions/:id/handoff` — optional `reasoningEffort`; same-agent override inherited, agent switch drops it.
- `POST /sessions/:id/respawn` — optional `reasoningEffort`; same-agent override inherited, agent switch drops it.
- `POST /sessions/:id/switch-auth`
- `GET /sessions/:id/todo`
- `POST /sessions/:id/todo` — `409 todo_ledger_empty|todo_open_work|todo_transition_conflict`. See [todo](commands.md#todo)
- `GET /sessions/:id/auto-ping-suppressions`
- `POST /sessions/:id/auto-ping-suppressions/unsubscribe`
- `POST /sessions/:id/auto-ping-suppressions/:suppressionId/resume` — `400|403|404|409`. See [auto-ping](commands.md#auto-ping)
- `POST /sessions/:id/queue/remove` — `{"message": "<exact queued text>"}`. See [send, queue](commands.md#send-queue)
- `POST /sessions/:id/queue/flush`
- `POST /sessions/:id/wake`
- `POST /sessions/:id/wake/cancel`
- `POST /sessions/:id/subscriptions`
- `POST /sessions/:id/subscriptions/:subId/remove`
- `POST /sessions/:id/slots` — see [spur-slots](commands.md#spur-slots)
- `POST /sessions/:id/sidecars/:name/start` — `409 sidecar_port_busy`, `503` on an unreadable tmux probe (retry)
- `POST /sessions/:id/sidecars/:name/stop` — see [Sidecars](commands.md#sidecars)
- `GET /sessions/:id/services`
- `GET /sessions/:id/services/:name`
- `POST /sessions/:id/services/:name/run`
- `GET /sessions/:id/artifacts/:path` — streams one artifact
- `GET /sessions/:id/session-memory`
- `GET /sessions/:id/session-memory/:key`
- `POST /sessions/:id/session-memory/:key`
- `POST /sessions/:id/session-memory/:key/resolve`
- `GET /sessions/:id/shared-memory/:scope`
- `GET /sessions/:id/shared-memory/:scope/:key`
- `POST /sessions/:id/shared-memory/:scope/:key`
- `DELETE /sessions/:id/shared-memory/:scope/:key`

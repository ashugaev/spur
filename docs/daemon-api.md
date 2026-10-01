# Daemon HTTP API

> Scope: route names only, one method + full path per line, every line `git grep`-able verbatim. Payload/status-code contracts: `v2/src/server.ts`. CLI usage: [commands.md](commands.md). Default `127.0.0.1:4310`.

- `GET /info`
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

- `GET /sessions`
- `POST /sessions`
- `POST /sessions/background`
- `POST /shepherd/spawn`
- `POST /sidecars/sweep`
- `GET /sessions/:id`
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
- `POST /sessions/:id/complete`
- `POST /sessions/:id/self-destruct`
- `POST /sessions/:id/kill`
- `POST /sessions/:id/restore`
- `POST /sessions/:id/reopen`
- `POST /sessions/:id/handoff`
- `POST /sessions/:id/respawn`
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
- `POST /sessions/:id/sidecars/:name/start`
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

# Connect an MCP client to Spur

Spur exposes the daemon API through MCP with full operator rights.
Use stdio locally or over SSH, or the installed loopback HTTP service.
[OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) connects private OpenAI products without public inbound ports.

## Connect stdio or SSH

Configure an MCP client's stdio command:

```json
{ "command": "spur", "args": ["--config", "<instance-config>", "mcp"] }
```

For a remote host, use `ssh <host> spur --config <instance-config> mcp` as the stdio command.
Use executable/config paths available in the remote noninteractive shell.
`SPUR_CONFIG` selects the instance when `--config` is omitted.
Without either, use the installed selection; [config precedence](configuration.md).
The daemon must run from the same installed runtime build.
MCP never starts or replaces the daemon and never replays writes.

## Connect HTTP

`spur init` and source deploy install `spur-mcp.service` alongside daemon/web.
The unit runs `spur mcp --http`; the default endpoint is `http://127.0.0.1:4311/mcp`.
Installer collisions with the actual web listener persist an omitted MCP port in config; explicit collisions fail installation.
Select the port in [instance config](configuration.md); HTTP stays bound to loopback.
Use a private transport for remote access; never expose this endpoint publicly.

The enabled unit restarts after crashes and reboot, stays available through daemon restart, and follows the installed version during updates.
`GET /healthz` reports MCP/daemon runtime identity and readiness; daemon downtime or build mismatch returns `503`.
For a build mismatch after an installed version update, restart the matching `spur-mcp.service` and recheck `/healthz`; leave the daemon running.
Check installation, linger and logs in [npm install](install-from-npm.md) or [source install](install-from-source.md).

## Discover and operate

- `describe_operations`: paged daemon operation catalog, fields, defaults and examples.
- `daemon_request`: invoke a catalog `operationId`, supplying path parameters, query and body.
- `list_projects`, `list_sessions`, `get_session`, `get_conversation`: discovery and inspection.
- `spawn_session`: full spawn request; background by default, `background: false` selects interactive spawn.
- `send_message`: full daemon send request.
- `wait_session`: wait for a new answer, question or terminal state, using the `after` cursor from spawn/send.
- `mcp_status`: MCP and daemon identity/readiness.

The catalog covers every daemon route: session lifecycle, queues, questions, logs, artifacts, services, subscriptions, source replies, ToDo, memory, projects, models, accounts, sidecars, shepherd and deployments.
No project filter or read-only mode: connected callers can change/delete projects and sessions, run commands, switch versions and invoke every daemon operation.
Grant access only to callers trusted as the host's operator.
Agent execution has the daemon user's filesystem and shell rights.

Conversation reads include raw tool/output/reasoning entries by default.
`view: "messages"` selects the bounded user/assistant projection.
For that projection, pass `nextFrom` as `from`; hidden entries still advance the cursor.
Use artifact/log operation references to retrieve files and runtime output.
Terminal WebSocket streams belong to the web service, outside the daemon API.

## Read large results and stage requests

Tool arguments and complete results are capped at 128 KiB; HTTP requests at 256 KiB.
Daemon replies retain HTTP status, body and `content-type`, `content-disposition`, `location`, `retry-after`, `x-spur-lifecycle-instance-id` headers, including errors.
Inline JSON includes parsed `body` and exact UTF-8 response text in `rawBody`.
JSON requiring byte-preserving retrieval uses pages even when small.
Paged JSON/binary replies return a `responseId` with a base64 byte page.
Call `read_response` with `responseId` and the returned `nextOffset` as `offset` until `eof`.
Pages default to 16 KiB, maximum 32 KiB; decode and concatenate bytes in offset order.
Call `release_response` with `responseId` to reclaim quota after reading; `{released: true}` means removed, and subsequent reads fail.
Unknown, already-removed and request-upload IDs return `{released: false}`; active reads return an in-use error.
Reading `eof` or closing a client does not dispose retained responses.

For large JSON writes, send sequential base64 chunks through `stage_request`, then pass its completed `bodyHandle` to `daemon_request`.
Chunks contain at most 32 KiB decoded; total request limit is 15,000,000 bytes.
Completed handles are consumed once at dispatch, including failed writes.
Response/request handles expire after 10 minutes and disappear when MCP restarts.
The host retains at most 32 handles within a 1 GiB spool budget; expiration/quota failures are explicit.

## Connect OpenAI products

Connect ChatGPT in three steps:

1. Create a [runtime API key](https://platform.openai.com/settings/organization/api-keys) in the intended Platform organization. Grant the key and its owner Tunnels Read + Use; [organization permissions](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#permissions-and-access).
2. Have an organization member with Tunnels Read + Manage create a tunnel in [Platform settings](https://platform.openai.com/settings/organization/tunnels), associated with that organization and the target ChatGPT workspace. Configure the external `tunnel-client` profile with `control_plane.tunnel_id`, `control_plane.organization_id` and Spur's loopback `/mcp` endpoint; [client setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#set-up-tunnel-client). Keep the client running.
3. In ChatGPT Plugins, select Add custom MCP server → Connection: Tunnel, choose the same tunnel, then Create as a plugin; [connection steps](https://developers.openai.com/plugins/deploy/connect-chatgpt#add-the-mcp-server). Install the plugin, select it with `@` in a new chat, and ask it to list Spur projects.

Keep credentials outside Spur config, command arguments, transcripts and chat.
Keep the runtime key in the private environment file below; the key and profile organization must match the tunnel's Platform organization.
`control_plane.organization_id` sets the `OpenAI-Organization` header; [official client configuration](https://github.com/openai/tunnel-client/blob/master/pkg/runtimeconfig/config.go).
MCP authentication and tunnel authentication are separate: selecting no MCP authentication still requires a tunnel runtime API key.
Full API-key permissions do not grant its owner access to an unrelated tunnel or organization.
Use [organization-level tunnel permissions](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#permissions-and-access), not project membership alone.
An empty `workspace_ids` grants no ChatGPT workspace access.
If the workspace selector is empty, verify the Platform organization and ChatGPT workspace are already linked; Enterprise manual association goes through the OpenAI account team. See [workspace association](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#associate-tunnels-with-the-right-organizations-and-workspaces).

To supervise an existing profile, create a private environment file:

```text
SPUR_MCP_TUNNEL_PROFILE=<profile-name>
CONTROL_PLANE_API_KEY=<runtime-key>
```

Use `~/.spur/mcp-tunnel.env` for npm user units or `/etc/spur/mcp-tunnel.env` for source system units; mode `0600`.
Re-run the matching installer/deploy to enable `spur-mcp-tunnel.service`.
An absent file leaves generic MCP healthy without OpenAI credentials; a configured tunnel must become ready for installation/update health to pass.
`spur mcp-tunnel` runs the configured profile against the loopback endpoint.
The [official guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#set-up-tunnel-client) owns profile setup and tunnel-client options.

Enable the plugin for [Dot](https://learn.chatgpt.com/docs/dots) where workspace permissions permit.
Verify each product separately: initialize, list projects, submit a task, read the answer, send a followup, and read its answer.
Local MCP and service recovery tests do not prove OpenAI account access or a product connection.
`tunnel-client doctor` and `/readyz` do not prove successful control-plane polling; inspect the `control-plane` component at `/health?details=true`.
For polling `401`/`403`, inspect the error code: `mismatched_organization` means the key and organization header disagree; `tunnel_active_organization_required` requires organization context; `tunnel_use_forbidden` means tunnel access was denied. See [official client troubleshooting](https://github.com/openai/tunnel-client/blob/master/docs/troubleshooting.md#authorization-failures-identify-the-failing-surface-first).
Secure MCP Tunnel supports private connections; [public plugin submission](https://developers.openai.com/plugins/deploy/submission) requires a stable public HTTPS MCP endpoint.

## Recover uncertain calls

Spawn acknowledges acceptance; inspect session state for launch failures.
Tool calls have a 90-second deadline.
`wait_session` defaults to 55 seconds, maximum 90 seconds; a timeout is a resumable observation, not task failure.
Queued/unconfirmed submissions, old idle and pre-existing questions do not prove new progress.
Unattributable questions time out; inspect returned raw conversation/question references.
`messagesPreview`/`textTruncated` mark bounded wait previews; read raw conversation for full entries.
Attachments and messages over 8192 characters remain unconfirmed by the bounded correlation view; inspect raw conversation and session state.
Use the returned cursor and inspect questions/conversation when waiting reports a reset or timeout.
After a disconnected or timed-out write, inspect daemon state before resubmitting.
`503 session_lifecycle_snapshot_changed` means the daemon could not assemble a stable session snapshot; retry read-only calls, inspect state before repeating writes.
After a version switch, reconnect; expired handles require a fresh read.

CLI/config references: [commands.md](commands.md), [configuration.md](configuration.md).

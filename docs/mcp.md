# Connect ChatGPT and Dot to Spur

Run `spur mcp` on the host with an existing, running Spur daemon.
Use [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for private access without public inbound ports.

## Select access

Point the tunnel's stdio command at `spur --config <instance-config> mcp`.
Use an absolute executable/config path when the tunnel runs outside your login shell.
`SPUR_CONFIG` selects the instance when `--config` is omitted.
The adapter neither creates config nor starts, replaces or stops the daemon.

Access includes every configured ordinary project by default; unconfigured and shepherd projects are excluded.
Append `--project <id>` to restrict access; repeat for several projects.
Read and write tools are enabled:

- `list_projects`, `list_sessions`: discover scoped projects and sessions.
- `get_session`, `get_conversation`: inspect state and user/assistant conversation.
- `spawn_session`: submit a background task using project defaults; poll state/conversation for its result.
- `send_message`: send a followup using daemon queue/interrupt defaults.

Spawn and followup run full-access coding agents that can replace/delete files and execute commands.
Project filtering restricts MCP targets; it does not sandbox agents' filesystem or shell access.
Conversation access exposes task content to the connected product.
Share the connection only with callers authorized for those reads and actions.

## Connect the private tunnel

Follow the official guide's installation, tunnel permissions, workspace association and runtime-key setup.
Keep credentials outside Spur config, command arguments and chat.
Run `tunnel-client help quickstart`; configure a stdio profile with `tunnel-client init`, setting `--mcp-command` to the selected Spur command above.
Validate with `tunnel-client doctor --profile <name> --explain`, then keep `tunnel-client run --profile <name>` running for discovery and calls.
The [official guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#set-up-tunnel-client) owns tunnel options and setup commands.

In ChatGPT Plugins, add a custom MCP server, select Connection: Tunnel and the associated tunnel, review permissions, then create the private plugin.
If the tunnel is absent, check its ChatGPT workspace association and Tunnels Read + Use permission.
Enable that plugin for [Dot](https://learn.chatgpt.com/docs/dots); availability depends on account/workspace permissions.

## Verify each product

In ChatGPT and Dot, call `list_projects`, inspect a session, submit a task, read the agent's answer, then send and inspect a followup.
Confirm the expected project and session for each call.
Local protocol tests do not prove tunnel connectivity or account access.

## Handle limits and failures

Tool calls have a shared 90-second deadline; startup has 30 seconds.
A successful spawn acknowledges a background task; read `get_session` for launch failure and `get_conversation` for agent answers.
The adapter never replays failed writes.
After an uncertain write, inspect session state before resubmitting.

Paginated reads default to 50 items/source entries, maximum 100.
Conversation `nextFrom` counts source entries, including hidden tool/reasoning entries; pass it as `from` to continue.
Metadata/message truncation is explicit; reduce page size after an output-limit error.
Tool schemas and output bounds: `v2/src/mcp.ts`; CLI reference: [commands.md](commands.md).

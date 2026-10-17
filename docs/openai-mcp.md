# Connect Spur to ChatGPT and dots

Run Spur MCP beside an existing daemon. Select its existing instance config:

```sh
spur --config <config> mcp
```

Omit `--config` to use `SPUR_CONFIG` or Spur's default instance config.
`mcp` reads config without creating it; missing config or incompatible/unreachable daemon exits.
Keep stdout for MCP frames. Diagnostics use stderr.

## Connect a private tunnel

Follow [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for installation, runtime credentials, organization/workspace association and permissions.
Use its stdio profile with:

```sh
--mcp-command "spur --config <config> mcp"
```

Keep `tunnel-client` running on a host that reaches Spur.
Creating tunnels requires Tunnels Read + Manage; running/selecting them requires Read + Use.
ChatGPT custom MCP access requires workspace permission.
In ChatGPT Plugins, add a custom MCP server, choose Tunnel, select the associated tunnel and create the plugin.
Enable that plugin for each dot that should use Spur; dot plugin availability depends on workspace access.
Use OpenAI's guide for connection settings and troubleshooting.

## Delegate one environment

Grant access only to trusted users and dots.
One connection reaches one daemon's configured projects and sessions; no per-caller isolation.
Agent prompts run with daemon user's configured access and can change files or invoke external services.
Prompt/answer text can contain private data. MCP omits runtime paths, launch settings, tool payloads and reasoning; it does not redact secrets from text.

## Check a workflow

Ask ChatGPT or a dot:

1. “List Spur projects and active sessions.”
2. “Start a session in project `<project>` asking the agent to reply `MCP-FIRST`.”
3. “Read that session until the assistant replies.”
4. “Send it a follow-up asking for `MCP-SECOND`, then read its reply.”

Spawn/send report acceptance and session state, not task completion.
Daemon calls stop waiting after 60 seconds; requests never retry automatically.
After mutation failure, inspect sessions before retrying: accepted work can continue after timeout or cancellation.

Conversation reads return user/assistant messages with source-entry indexes.
Default read starts at transcript tail; request `from: 0` for history, then use `nextFrom` while `hasMore`.
Each read caps 20 messages, 8,000 UTF-16 units per message and 24,000 total text units.
`truncated: true` consumes clipped text without continuation; `reset: true` signals cursor reset after transcript shrink or unavailable history.
Index-preserving transcript replacement is not detected.
Lists use mutable offset snapshots; successful tool results cap 1 MiB.

Tool schemas and projections: [source](../v2/src/mcp.ts). CLI: [commands](commands.md).

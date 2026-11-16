# Provider accounts

> Scope: use saved Claude/Codex authorization profiles.

Keep profile IDs and provider pool choices outside YAML.
CLI: [`spur auth accounts|login|add|pool|switch`](commands.md#service-memory-agent-issue-comment-seen-subscribe).
HTTP: [account operations](daemon-api.md).

## Accounts UI

Footer Accounts menu: one section per provider, Claude and Codex.

- Accounts show provider identity (email, organization or plan; API keys show the last 4) and quota left.
- Set the provider default and toggle Auto-rotation.
- Add and Sign in open a method picker.
- Claude: account (open link, paste returned URL or `code#state`) or API key.
- Codex: device code (default), browser (open link, paste returned URL) or API key.
- Ready only after a test request with the new credential succeeds; failure keeps the account signed out.
- Every error offers Continue in terminal and Try again.
- Terminal icon in the dialog header cancels the attempt and opens a terminal running native sign-in for that account.
- Terminal shows Signed in only after the same test request; exit or Close without it shows Not signed in.
- Close cancels unfinished sign-in; remove rejects an account used by a live session.

Dashboard alert row per broken managed account or host login, above the agents list: Sign in and terminal icon.
Row clears after a verified sign-in. Host rows open the terminal directly.

Spawn dialog Account picker: Auto or an identified account; signed-out ones are disabled.
Session Switch account: another profile or back to Auto, for the next request.

Legacy Claude IDs remain, labels are ignored; sign in again for managed routing. An account shows its identity after sign-in.
Host credentials and existing direct processes remain untouched.

## Per-session switch

Select a profile with [`spawn --auth-account`](commands.md#spawn).
An explicit profile stays pinned; omission uses Auto when the provider pool has a ready account.
Omission with no ready account launches with host authorization.

Managed Claude/Codex sessions change account for the next request through
[switch-auth](daemon-api.md#session-routes); current requests retain their account.
Direct sessions enter managed routing on explicit restore/respawn.
Handoff to the same provider keeps a pinned profile; another provider, Auto, or a removed profile gives Auto.

Managed routing preserves native session context and process identity during account changes.
Managed Claude links host `~/.claude` user config (`CLAUDE.md`, `settings.json`, skills, agents, commands, plugins, hooks, output styles) and user MCP servers; never host credentials. Host `settings.json` with `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport` or auth/endpoint env (`ANTHROPIC_*` except `*_MODEL`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*_AUTH`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`) becomes a private copy without those keys.
User MCP servers and that settings copy live in owner-only (0600) files under the session tool dir; complete or kill removes them, restore writes them again.
Codex uses Responses HTTP streaming; provider credentials stay with the local proxy.

## Auto-rotation

Each provider pool owns its default and Auto-rotation choice.
Auto retains its account after success; quota triggers failover when enabled.
Auto leaves an account that needs sign-in for a ready one; failover prefers the least-used ready account.
Pinned sessions never fail over.

Cooldowns apply across sessions. Episode limits survive retries and restarts;
successful generation or manual binding change resets the episode.
Policy defaults and constraints: [configuration](configuration.md#field-reference).

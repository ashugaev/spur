# Provider accounts

> Scope: use saved Claude/Codex authorization profiles.

Keep profile IDs, labels and provider pool choices outside YAML.
CLI: [`spur auth accounts|login|add|pool|switch`](commands.md#service-memory-agent-issue-comment-seen-subscribe).
HTTP: [account operations](daemon-api.md).

## Accounts UI

Footer Accounts menu: one section per provider, Claude and Codex.

- Profiles show label, status and quota cooldown.
- Set the provider default and toggle Auto-rotation.
- Add opens managed OAuth sign-in; follow its URL/code prompt. Sign in again for a profile that needs it.
- Readiness requires completed OAuth and durable registration.
- Close cancels unfinished sign-in; remove rejects an account used by a live session.

Spawn dialog Auth picker: Auto or a ready profile.
Session Switch auth: another profile or back to Auto, for the next request.

Legacy Claude labels/IDs remain; sign in again for managed routing.
Host credentials and existing direct processes remain untouched.

## Per-session switch

Select a profile with [`spawn --auth-account`](commands.md#spawn).
An explicit profile stays pinned; omission uses Auto when the provider pool has a ready account.
Omission with no ready account launches with host authorization.

Managed Claude/Codex sessions change account for the next request through
[switch-auth](daemon-api.md#session-routes); current requests retain their account.
Direct sessions enter managed routing on explicit restore/respawn.

Managed routing preserves native session context and process identity during account changes.
Managed Claude links host `~/.claude` user config (`CLAUDE.md`, `settings.json`, skills, agents, commands, plugins, hooks, output styles) and user MCP servers; never host credentials. Host `settings.json` with `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport` or auth/endpoint env (`ANTHROPIC_*` except `*_MODEL`, `CLAUDE_CODE_USE_*`) becomes a private copy without those keys.
Codex uses Responses HTTP streaming; provider credentials stay with the local proxy.

## Auto-rotation

Each provider pool owns its default and Auto-rotation choice.
Auto retains its account after success; quota triggers failover when enabled.
Auto leaves an account that needs sign-in for a ready one; failover prefers the least-used ready account.
Pinned sessions never fail over.

Cooldowns apply across sessions. Episode limits survive retries and restarts;
successful generation or manual binding change resets the episode.
Policy defaults and constraints: [configuration](configuration.md#field-reference).

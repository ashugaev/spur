# Provider accounts

> Scope: use saved Claude/Codex authorization profiles.

Keep profile IDs, labels and provider pool choices outside YAML.
Discover profiles and sign in through [`spur auth`](commands.md#service-memory-agent-issue-comment-seen-subscribe).
Create, rename, remove and select provider defaults through [account operations](daemon-api.md).

## Accounts UI

Footer Accounts retains the Claude login terminal.

- Add opens managed OAuth sign-in; follow its URL/code prompt.
- Readiness requires completed OAuth and durable registration.
- Close cancels unfinished sign-in; remove rejects an account used by a live session.

Legacy Claude labels/IDs remain; sign in again for managed routing.
Host credentials and existing direct processes remain untouched.

## Per-session switch

Select a profile with [`spawn --auth-account`](commands.md#spawn).
An explicit profile stays pinned; omission uses Auto when a managed pool exists.
An empty or unready managed pool rejects launch instead of using host authorization.

Managed Claude/Codex sessions change account for the next request through
[switch-auth](daemon-api.md#session-routes); current requests retain their account.
Direct sessions enter managed routing on explicit restore/respawn.

Managed routing preserves native session context and process identity during account changes.
Codex uses Responses HTTP streaming; provider credentials stay with the local proxy.

## Auto-rotation

Each provider pool owns its default and Auto-rotation choice.
Auto retains its account after success; quota triggers failover when enabled.
Pinned sessions never fail over.

Cooldowns apply across sessions. Episode limits survive retries and restarts;
successful generation or manual binding change resets the episode.
Policy defaults and constraints: [configuration](configuration.md#field-reference).

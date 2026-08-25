# Claude accounts

Rotate multiple claude login accounts across the rate limit. Each account: isolated `CLAUDE_CONFIG_DIR` in a runtime store (`<dataDir>/claude-accounts.json` + `<dataDir>/claude-accounts/<id>/`), never declared in config.

## Accounts UI

StatusBar footer "Accounts" menu.

- Add opens an interactive login terminal; run `/login` (OAuth). Spur auto-detects completion on `.credentials.json`.
- Select sets the active account.
- Remove drops an account.

The default `~/.claude` login auto-adopts as account `default` when its `.credentials.json` exists.

## Per-session switch

Claude only. Atomic credential swap in `<dataDir>/session-tools/<id>/claude-home/`, no kill or relaunch — the live process rereads credentials on its next request.

Ready = credentials present + onboarding complete. A session predating the session-home layout relaunches once, as migration. A switch mid-work forces through regardless. `projects/` in the session home symlinks to `~/.claude/projects`, so `--resume <uuid>` keeps history across a rotation.

## Auto-rotation

Config toggle: [`authRotation.autoRotateOnRateLimit`](configuration.md), instance config only. Agent-agnostic policy; the account store itself is claude-only today.

On: a `rate_limited` claude session rotates to the next ready, non-cooldown account. Guarded by `authRotation.cooldownMinutes` and `authRotation.maxRotationsPerEpisode`. When every account is limited, falls through to the reactivation nudge ([`rateLimitReactivation`](configuration.md)).

CLAUDE AUTH ROTATION

Rotate claude login accounts across the rate limit. Each account: isolated `CLAUDE_CONFIG_DIR` in a runtime store (`<dataDir>/claude-accounts.json` + `<dataDir>/claude-accounts/<id>/`), never declared in config.

  Accounts UI: StatusBar footer "Accounts" menu — add opens an interactive login terminal, operator runs `/login` OAuth, Spur auto-detects on `.credentials.json`; select sets active; remove drops it. Default `~/.claude` login auto-adopts as account "default" when its `.credentials.json` exists.
  Per-session switch (claude only): atomic credential swap in `<dataDir>/session-tools/<id>/claude-home/`, no kill or relaunch — the live process rereads credentials on its next request. Ready = credentials + onboarding complete. Pre-session-home sessions relaunch once as migration. Force switches mid-work. `projects/` in the session home symlinks to `~/.claude/projects`, so `--resume <uuid>` keeps history across rotation.
  Auto-rotation: config toggle `authRotation.autoRotateOnRateLimit`, field reference in `docs/configuration.md`. Agent-agnostic policy; account store is claude-only today. On: a `rate_limited` claude session rotates to the next ready, non-cooldown account. Guards: `cooldownMinutes` (skip window), `maxRotationsPerEpisode` (cap per episode). All limited -> falls through to the reactivation nudge.
  Instance-only, same footgun as `rateLimitReactivation`/`tags`: parsed only in instance config; a per-project `spur.yaml authRotation:` is silently ignored.

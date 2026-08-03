---
name: context-audit
description: Audits everything that enters an agent's context — skills, agent definitions, CLAUDE.md/AGENTS.md, rules files, MCP servers, tool surfaces — and reports what to cut, merge, or migrate off MCP. Measures the context budget and judges how files relate across repo and user-global scope. Use when reviewing a diff that touches agent-facing text or MCP config, when context feels bloated, when a stated rule is being ignored, or when asked to census or shrink agent configuration. Don't use for prose quality inside a single file (skill-writer), code simplification (code-simplifier), or published docs (docs).
---

# Context Audit

Every token competes. Rank findings by tokens saved x adherence recovered.

## Modes

| Mode | Scope | Run |
| --- | --- | --- |
| SCOPED | one diff | Check only surfaces the diff touches |
| SWEEP | everything | `scripts/census.sh [repo_root]`, `scripts/mcp-scope.sh` |
| NEGOTIATE | one named surface | See Negotiate below |

Default to SCOPED on a diff, SWEEP on first run or "audit my context config", NEGOTIATE when a cut is contested.

## MCP protocol

Decision rule: keep MCP only when a CLI cannot do the job. Default is migrate. A CLI adds no per-tool listing; tool-choice accuracy degrades past 30-50 tools; each MCP tool costs 150-350 tokens, loaded every session whether or not it is called.

Order: migrate anything with a CLI -> demote every user-scope server owned by one project -> disable never-called tools on what remains, then re-measure.

Scope rule: one repo and shareable -> project (`.mcp.json`, committed). One repo with private creds -> local. Every session and no CLI exists -> user.

CLI mapping:

| Server | CLI |
| --- | --- |
| github | `gh` |
| sentry | `sentry-cli` |
| atlassian / jira | `acli` |
| playwright | `playwright` (scripted runs only; MCP for live driving) |
| filesystem | shell, Read/Grep/Glob |
| aws | `aws` |
| gcp | `gcloud` |
| postgres | `psql` |

No CLI exists: figma (Code Connect CLI only publishes), linear, notion, slack.

Keep MCP when: a live stateful loop such as driving a browser across turns; a harness with no shell; per-user OAuth with tenant isolation and an audit trail; a push or streaming channel that originates events, which a CLI cannot; a SaaS with no CLI at all.

Traps: confirm a deletion with `claude mcp list` no longer showing the server. Per-tool disable is unproven — re-measure `/context` after, remove the whole server if the schema persists. Never delete on the INERT verdict alone; absence from `claude mcp list` first, delete second.

Run `scripts/mcp-scope.sh` for the live table (`vendor server scope owner cli cli_status verdict`).

## Checklist

Ranked by yield. 1-3 token mass, 4-5 adherence, 6-12 hygiene.

| # | Check | How |
| --- | --- | --- |
| 1 | MCP server with a CLI equivalent | `mcp-scope.sh`, rows with `cli_status=found` |
| 2 | User-scope server owned by one project | `scope=user` and name matches one repo's domain |
| 3 | Tool search off | `/context` vs `ENABLE_TOOL_SEARCH=false /context` |
| 4 | Two surfaces answer one question differently | grep the directive's noun across every surface |
| 5 | Same rule stated twice | same grep, identical intent |
| 6 | Always-loaded total over budget | `SUBTOTAL always`; CLAUDE.md target under 200 lines |
| 7 | Over 50 imperative lines in one always-loaded surface | count verb-initial lines |
| 8 | Content derivable from the codebase | directory trees, dependency lists, architecture prose |
| 9 | Instructions the model already follows | persona preambles, "verify your work", "if in doubt use X" |
| 10 | Two descriptions match one trigger | read every skill `description` side by side |
| 11 | Prohibition in prose that must be a guarantee | any "never" whose breach causes damage -> PreToolUse hook |
| 12 | Dangling path reference | extract backticked paths, `test -e` each |

Excluded on purpose: mirror drift (repo-shaped, not portable); instruction position within a file (vendor-measured, unreplicated); politeness and filler (`skill-writer` owns it).

## Negotiate

Cuts settled by two opposed subagents, spawned in parallel through the runtime's own native mechanism — Claude's built-in parallel subagents, Codex's `multi_agent`. Never a Spur session. Neither role is a separate agent definition file; both ship as prompt blocks below.

1. Input: the surface text plus the candidate cut list from Checklist.
2. Spawn CUT and KEEP in parallel. Neither sees the other's output.
   - CUT: propose maximal deletion. One line per cut naming why it is derivable, duplicated, stale, or already model-default.
   - KEEP: for each candidate, name the concrete failure that follows deletion — a specific wrong action the agent would then take. A defense that names no failure is not a defense.
3. Merge deterministically in the caller, not a third agent:
   - Proposed, undefended -> delete.
   - Proposed, defended, named failure already prevented elsewhere (hook, narrower surface) -> delete, cite the preventer.
   - Proposed, defended with a live failure -> one rebuttal round for CUT only: concede or refute.
4. Still unresolved -> report CONTESTED with both one-line arguments. Never auto-delete a contested line.

Default is deletion. Text survives by earning a concession, not by inertia.

## Measure

`claude -p "/context"` prints a category table plus per-item tables (`### MCP Tools`, `### Skills`, `### Memory Files`, `### Custom Agents`) — one real API turn, run on request only. Ground truth total: `claude -p "hi" --output-format json | jq '.usage | .input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens'`.

Traps:

- `~/.claude/settings.json` `mcpServers` is not read by Claude Code 2.1.220 — effective config comes only from `claude mcp list`.
- `codex debug prompt-input` excludes tool schemas, so it undercounts exactly what the MCP protocol cares about. Never source MCP findings from it.
- `bytes/4` is prose-calibrated and wrong for JSON tool schemas. MCP token figures come only from the measured `/context` table.

## Report

Table: `finding | surface | est_tokens | verdict | evidence`. One row per finding, ranked by tokens saved x adherence recovered, highest first. `verdict` is one of migrate, cut, keep, CONTESTED.

Write to `$SPUR_SESSION_ARTIFACTS_DIR/context-audit/findings.md`.

## Boundaries

- Prose quality inside one file: `skill-writer`.
- Code simplification: `code-simplifier`.
- Published docs under `docs/` or root doc files: `docs`.
- Command and config field semantics: `docs/commands.md` / `docs/configuration.md` plus the `spur` skill.

## Evidence

Every number above traces to `references/evidence.md` — one line per claim, no narrative, no URLs here.

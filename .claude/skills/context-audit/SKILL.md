---
name: context-audit
description: Audits everything that enters an agent's context — skills, agent definitions, CLAUDE.md/AGENTS.md, rules files, MCP servers, tool surfaces — and reports what to cut, merge, or migrate off MCP. Measures the context budget and judges how files relate across repo and user-global scope. Use when reviewing a diff that touches agent-facing text or MCP config, when context feels bloated, when a stated rule is being ignored, or when asked to census or shrink agent configuration. Don't use for prose quality inside a single file (skill-writer), code simplification (code-simplifier), or published docs (docs).
---

# Context Audit

`<skill dir>` below means the directory holding this file: `.claude/skills/context-audit/` for Claude, `.agents/skills/context-audit/` for Codex.

## Modes

| Mode | Scope | Run |
| --- | --- | --- |
| SCOPED | one diff | Check only surfaces the diff touches |
| SWEEP | everything | `<skill dir>/scripts/census.sh [repo_root]`, `<skill dir>/scripts/mcp-scope.sh [repo_root]` |
| NEGOTIATE | one named surface | See Negotiate below |

Default to SCOPED on a diff, SWEEP on first run or "audit my context config", NEGOTIATE when a cut is contested.

## MCP protocol

Decision rule: keep MCP only when a CLI cannot do the job. Default is migrate.

Order: migrate anything with a CLI -> demote every user-scope server owned by one project -> disable never-called tools on what remains, then re-measure.

Scope rule: one repo and shareable -> project (`.mcp.json`, committed). One repo with private creds -> local. Every session and no CLI exists -> user.

Server-to-CLI mapping and the keep-list live in `<skill dir>/scripts/mcp-scope.sh`, functions `cli_for` and `verdict_for`. Read them there; they are what runs.

Keep MCP when the mapping has no entry: a live stateful loop such as driving a browser across turns; a harness with no shell; per-user OAuth with tenant isolation and an audit trail; a push or streaming channel that originates events, which a CLI cannot.

Traps:

- Prove the replacement CLI before removing the server. Run one real read through it and show the output. `cli_status=found` means on PATH, not authenticated. Untested CLI, server stays.
- Back up any surface outside the repo before editing it: `<skill dir>/scripts/agent-backup <path> <label>`.
- Per-tool disable is unproven — re-measure `/context` after, remove the whole server if the schema persists.
- Never cut on the INERT verdict alone. Absence from `claude mcp list` first, cut second.

## Checklist

| # | Check | How |
| --- | --- | --- |
| 1 | MCP server with a CLI equivalent | `<skill dir>/scripts/mcp-scope.sh`, rows with `cli_status=found` |
| 2 | User-scope server owned by one project | `scope=user` and name matches one repo's domain |
| 3 | Tool search off | `/context` vs `ENABLE_TOOL_SEARCH=false /context` |
| 4 | Two surfaces answer one question differently | grep the directive's noun across every surface |
| 5 | Same rule stated twice | same grep, identical intent |
| 6 | Always-loaded total over budget | `SUBTOTAL always <vendor>` row for the session's own vendor; CLAUDE.md target under 200 lines |
| 7 | Over 50 imperative lines in one always-loaded surface | count verb-initial lines |
| 8 | Content derivable from the codebase | directory trees, dependency lists, architecture prose |
| 9 | Instructions the model already follows | persona preambles, "verify your work", "if in doubt use X" |
| 10 | Two descriptions match one trigger | read every skill `description` side by side |
| 11 | Prohibition in prose that must be a guarantee | any "never" whose breach causes damage -> PreToolUse hook |
| 12 | Dangling path reference | extract backticked paths, `test -e` each |

Excluded on purpose: mirror drift (repo-shaped, not portable); instruction position within a file (vendor-measured, unreplicated); politeness and filler (`skill-writer` owns it).

## Negotiate

Cuts settled by two opposed subagents, spawned in parallel through the runtime's own native mechanism — Claude's built-in parallel subagents, Codex's `multi_agent`. Never a Spur session. Neither role is a separate agent definition file.

1. Input: the surface text plus the candidate cut list from Checklist.
2. Spawn CUT and KEEP in parallel. Neither sees the other's output.
   - CUT: propose the maximal cut. One line per cut naming why it is derivable, duplicated, stale, or already model-default.
   - KEEP: for each candidate, name the concrete failure that follows the cut — a specific wrong action the agent would then take. A defense that names no failure is not a defense.
3. Merge deterministically in the caller, not a third agent:
   - Proposed, undefended -> cut.
   - Proposed, defended, named failure already prevented elsewhere (hook, narrower surface) -> cut, cite the preventer.
   - Proposed, defended with a live failure -> one rebuttal round for CUT only: concede or refute.
4. Still unresolved -> report CONTESTED with both one-line arguments. Never auto-cut a contested line.

## Measure

`claude -p "/context"` prints a category table plus per-item tables (`### MCP Tools`, `### Skills`, `### Memory Files`, `### Custom Agents`) — one real API turn, run on request only. Ground truth total: `claude -p "hi" --output-format json | jq '.usage | .input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens'`.

Traps:

- `~/.claude/settings.json` `mcpServers` is not read by Claude Code 2.1.220 — effective config comes only from `claude mcp list`.
- `codex debug prompt-input` excludes tool schemas, so it undercounts exactly what the MCP protocol cares about. Never source MCP findings from it.
- `bytes/4` is prose-calibrated and wrong for JSON tool schemas. MCP token figures come only from the measured `/context` table.

## Report

Table: `finding | surface | est_tokens | verdict | evidence`. One row per finding, ranked by tokens saved x adherence recovered, highest first. `verdict` is one of migrate, cut, keep, CONTESTED.

Write to `$SPUR_SESSION_ARTIFACTS_DIR/context-audit/findings.txt`, plain text.

## Boundaries

Command and config field semantics: `docs/commands.md` / `docs/configuration.md` plus the `spur` skill.

## Evidence

Every number traces to `references/evidence.md`. No URLs here.

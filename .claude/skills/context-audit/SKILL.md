---
name: context-audit
description: Audits everything that enters an agent's context — skills, agent definitions, CLAUDE.md/AGENTS.md, rules files, MCP servers, tool surfaces — and reports what to cut, merge, or migrate off MCP. Measures the context budget and judges how files relate across repo and user-global scope. Use when reviewing a diff that touches agent-facing text or MCP config, when context feels bloated, when a stated rule is being ignored, or when asked to census or shrink agent configuration. Don't use for prose quality inside a single file (skill-writer), code simplification (code-simplifier), or published docs (docs).
---

CONTEXT AUDIT

<skill dir> means the directory holding this file: .claude/skills/context-audit
for Claude, .agents/skills/context-audit for Codex.


MODES

  SCOPED      one diff        check only surfaces the diff touches
  SWEEP       everything      <skill dir>/scripts/census.sh [repo_root]
                              <skill dir>/scripts/mcp-scope.sh [repo_root]
  NEGOTIATE   one surface     see NEGOTIATE below

  Diff -> SCOPED. First run, or "audit my context config" -> SWEEP.
  Contested cut -> NEGOTIATE.


MCP PROTOCOL

Keep MCP only when a CLI cannot do the job. Default is migrate.

  Order   migrate anything with a CLI
          demote every user-scope server owned by one project
          disable never-called tools on what remains, re-measure

  Scope   one repo, shareable       project, .mcp.json, committed
          one repo, private creds   local
          every session, no CLI     user

Mapping and keep-list live in <skill dir>/scripts/mcp-scope.sh, functions
cli_for and verdict_for. They are what runs.

Keep MCP when the mapping has no entry:

  live stateful loop, driving a browser across turns
  harness with no shell
  per-user OAuth with tenant isolation and audit trail
  push or streaming channel that originates events, which a CLI cannot

Traps:

  Prove the replacement CLI before removing the server. Run one real read,
  show the output. cli_status=found means on PATH, not authenticated.
  Untested CLI, server stays.
  Back up any surface outside the repo before editing it:
  <skill dir>/scripts/agent-backup <path> <label>
  Per-tool disable is unproven. Re-measure /context after, remove the whole
  server if the schema persists.
  Never cut on INERT alone. Absence from claude mcp list first, cut second.


CHECKLIST

Ranked by yield.

  1   MCP server with a CLI equivalent        mcp-scope.sh, cli_status=found
  2   User-scope server owned by one project  scope=user, name matches one repo
  3   Tool search off                         /context vs ENABLE_TOOL_SEARCH=false
  4   Two surfaces answer one question twice  grep the directive noun everywhere
  5   Same rule stated twice                  same grep, identical intent
  6   Always-loaded over budget               SUBTOTAL always <vendor> for this
                                              session's vendor, CLAUDE.md under 200 lines
  7   Over 50 imperative lines in one surface count verb-initial lines
  8   Content derivable from the codebase     dir trees, dep lists, architecture prose
  9   Instructions the model already follows  persona, verify-your-work, if-in-doubt-use-X
  10  Two descriptions match one trigger      read every description side by side
  11  Prohibition that must be a guarantee    move it to a PreToolUse hook
  12  Dangling path reference                 extract backticked paths, test -e each

Excluded on purpose: mirror drift, repo-shaped not portable. Instruction
position within a file, vendor-measured and unreplicated. Politeness and
filler, skill-writer owns it.


NEGOTIATE

Cuts settled by two opposed subagents, spawned in parallel through the
runtime's own native mechanism: Claude's built-in parallel subagents,
Codex's multi_agent. Never a Spur session. Neither role is a separate
agent definition file.

  1  Input is the surface text plus the candidate cut list from CHECKLIST.
  2  Spawn CUT and KEEP in parallel. Neither sees the other's output.
       CUT    propose the maximal cut. One line per cut naming why it is
              derivable, duplicated, stale, or already model-default.
       KEEP   for each candidate name the concrete failure that follows the
              cut, a specific wrong action the agent would then take.
              A defense naming no failure is not a defense.
  3  Merge deterministically in the caller, not a third agent:
       proposed, undefended                        cut
       defended, failure already prevented elsewhere  cut, cite the preventer
       defended with a live failure                one rebuttal round for CUT
                                                   only: concede or refute
  4  Still unresolved, report CONTESTED with both one-line arguments.
     Never auto-cut a contested line.


MEASURE

claude -p "/context" prints a category table plus per-item tables for MCP
tools, skills, memory files, custom agents. One real API turn, run on
request only.

  Ground truth total:
  claude -p "hi" --output-format json | jq '.usage | .input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens'

Traps:

  ~/.claude/settings.json mcpServers is not read by Claude Code 2.1.220.
  Effective config comes only from claude mcp list.
  codex debug prompt-input excludes tool schemas, so it undercounts exactly
  what the MCP protocol cares about. Never source MCP findings from it.
  bytes/4 is prose-calibrated and wrong for JSON tool schemas. MCP token
  figures come only from the measured /context table.


REPORT

  Columns   finding, surface, est_tokens, verdict, evidence
  Order     tokens saved x adherence recovered, highest first
  Verdict   migrate | cut | keep | CONTESTED
  Write to  $SPUR_SESSION_ARTIFACTS_DIR/context-audit/findings.txt, plain text


BOUNDARIES

Prose form and prose quality inside one surface: skill-writer.
Command and config field semantics: docs/commands.md, docs/configuration.md,
plus the spur skill.


EVIDENCE

Every number traces to references/evidence.md. No URLs here.

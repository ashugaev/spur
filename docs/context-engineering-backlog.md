# Context-engineering backlog

Deferred runtime/feature items from the adaptive-workflow rewrite (iteration 2). Prose principles ship now in the manager skill and the architect spec; these need Spur code, not prose.

See also: `docs/workflow-technical-updates.md` — iteration-1 runtime/tooling follow-ups.

Anchors cite figures as reported by their sources — directional, not independently verified.

## Active context compression / auto-forget

Why: full session history is rarely optimal; stale turns crowd the window and raise cost.
Needed: Spur session context-compaction that promotes stable facts into a curated Knowledge block and drops stale history mid-session.
Anchor: Active Context Compression research — reports a large token reduction (roughly half) without accuracy loss on SWE-bench-style tasks.

## Auto-compact the agent between iterations

Why: each runtime agent ships a native context-compaction command (Claude Code `/compact`; the Codex compaction step) that curates the window without a custom compressor — the cheapest path to the compression win above.
Needed: have Spur auto-invoke the agent's native compact command at iteration/gate boundaries or via runtime hooks (Claude Code PreCompact/Stop/SubagentStop, the Codex equivalent) instead of only when the window fills. Decide the trigger points (between manager gates, after a fix cycle, on a token threshold) and which structured artifacts (spec, decisions) must survive each compaction.
Anchor: builds on the active-context-compression item above; drives the agent's own command rather than a bespoke Knowledge block.

## Selective structured summary over full trace

Why: threading full execution traces between related sessions/handoffs is noisy and expensive.
Needed: when Spur threads context between sessions/handoffs, pass a curated structured summary or retrieve only the needed history, not the full execution trace.
Anchor: SWE-ContextBench (as reported) — a right-sized summary beat full history on accuracy, cost, and latency.

## Stable evolving memory + reflection (anti context-collapse)

Why: rewriting a summary each turn loses detail (context collapse).
Needed: persistent memory that appends new facts + reflection to a stable structured store instead of rewriting a summary each turn; maps to enhancing Spur's auto-memory.
Anchor: ACE (Berkeley) — ~+10% on agent benchmarks.

## Experience-not-history store

Why: chat logs carry dead ends and intermediate thoughts that degrade downstream results.
Needed: cross-task experience objects (problem / repo facts / decision / why / files touched / remaining assumptions) instead of chat logs.
Anchor: SWE-ContextBench and Anthropic Context Engineering (as reported).

## Context as curated resource

Why: the guiding principle for the items above — curate what enters the window rather than accumulate.
Needed: treat context as a curated resource across Spur handoffs and memory, applied to the compaction, summary, and memory items above.
Anchor: Anthropic Context Engineering (2025).

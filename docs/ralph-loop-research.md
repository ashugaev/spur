# Ralph loop: what it is, and how to run one in Spur

## TL;DR

"Ralph" (aka the Ralph Wiggum technique) is not a product — it's a pattern: keep
re-invoking a coding agent on the same declarative prompt, with disk state
(a plan file + git history) as the only memory across invocations, until an
objective completion condition is met. Spur already has every primitive this
pattern needs — worktree isolation, full-autonomy launch flags for all three
agents, and a `cron` source + `spawn` trigger mechanism that is agent-agnostic.
Running a Ralph loop for Codex, Cursor, or Claude in this repo is a `spur.yaml`
config addition, not new code (see [Recipe A](#recipe-a-cron--spawn--the-native-spur-fit)).

## What is the Ralph loop

Coined by Geoffrey Huntley in mid-2025 ([ghuntley.com/ralph](https://ghuntley.com/ralph/),
[github.com/ghuntley/how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)).
Original form:

```bash
while :; do cat PROMPT.md | claude ; done
```

Each iteration is a brand-new agent invocation with zero conversation history.
State survives only through what's on disk:

- `PROMPT.md` — the fixed instruction, identical every iteration
- `AGENTS.md` — a short (~60 line) operational guide: build/test/lint commands,
  codebase conventions. Not a status file.
- `specs/*.md` — requirements, one file per topic
- `IMPLEMENTATION_PLAN.md` — a prioritized task list the agent itself reads,
  updates, and re-prioritizes every iteration. This is the actual shared state
  between otherwise-isolated runs.

Per-iteration flow: orient (read specs + plan + code) → pick the single
highest-priority task → implement it completely → run tests/lint/typecheck →
commit → update the plan file → exit. The next iteration starts fresh and
picks up where the plan file says to.

Why fresh context per iteration, instead of one long session: Huntley's own
lesson from the official Claude Code plugin (below) is that letting the loop
run forever _inside one growing context_ diverges — it produces "overbaked"
emergent behavior (his example: a GTD app that spontaneously grew post-quantum
crypto support). Partitioning into discrete, bounded context windows is a
deliberate guardrail, not an accident of the original bash implementation.

Guardrails that matter in practice:

- One task per iteration, commit only when tests pass — bounds blast radius per cycle.
- `git reset --hard` / re-run is the recommended recovery — code is cheap, don't hand-patch.
- Cap iterations (`-n 50`, `--max-iterations`) — unbounded loops burn cost and drift.
- Run long unattended stretches (overnight, on cron) with small mergeable diffs, not one giant refactor.
- Ralph needs a well-understood end-state and testable acceptance criteria; it's a poor fit for open-ended exploration.

Sources:

- [Ralph Wiggum as a "software engineer"](https://ghuntley.com/ralph/)
- [how-to-ralph-wiggum (recipe repo)](https://github.com/ghuntley/how-to-ralph-wiggum)
- [A Brief History of Ralph — HumanLayer](https://www.humanlayer.dev/blog/brief-history-of-ralph)
- [Ralph Wiggum Loop — prg.sh notes](https://prg.sh/notes/Ralph-Wiggum-Loop)

## Per-tool native support (state as of mid-2026)

- Claude Code: official `ralph-loop` plugin
  (`/plugin install ralph-loop@claude-plugins-official`) plus the built-in
  `/loop` command. The plugin re-feeds the prompt via a Stop hook inside one
  session (`--completion-promise`, `--max-iterations`) — not the fresh-context
  original, the same session keeps growing. `/loop` is time-interval polling,
  not completion-driven. This session's own `/loop` skill and `ScheduleWakeup`
  tool are the `/loop` primitive.
- Codex CLI: the `/goal` command (shipped 0.128.0) is Ralph as a first-class
  primitive. The classic form still works too:
  `while :; do cat PROMPT.md | codex exec --sandbox workspace-write --ask-for-approval never; done`
  (or `--dangerously-bypass-approvals-and-sandbox` when the sandbox boundary is
  external, e.g. a worktree/container). Note `codex exec` (headless) is
  read-only unless a write-scope or bypass flag is passed — the detail people
  miss first.
- Cursor: the `cursor-agent` headless CLI loops cleanly with the same
  `while :; do ...; done` shape. No Cursor-specific plugin equivalent to
  Claude's — it's the classic bash-loop pattern, unmodified.

Sources:

- [Ralph Wiggum Loop for Claude Code — awesomeclaude.ai](https://awesomeclaude.ai/ralph-wiggum)
- [How to Run a Ralph Loop With the Codex CLI — ralphloop.sh](https://ralphloop.sh/blog/ralph-loop-with-codex-cli/)
- [How to Run the Codex CLI in an Autonomous Loop — ralphloop.sh](https://ralphloop.sh/blog/run-codex-cli-in-a-loop/)
- [OpenAI Codex /goal Command — ralphable.com](https://ralphable.com/blog/codex-goal-command-ralph-loop-openai-built-in-autonomous-coding-agent-2026)

## How to implement in Spur

Spur already runs every agent inside an isolated git worktree with
full-autonomy launch flags baked in
(`v2/src/agents/{claude,codex,cursor}.ts`):

- Claude: `claude --dangerously-skip-permissions`
- Codex: `codex --enable hooks --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`
- Cursor: `cursor-agent --force --sandbox disabled`

That's already the "sandbox is the boundary, agent shouldn't police itself"
setup Ralph guides recommend for Codex specifically — Spur gets this for free,
for all three agents, uniformly. So implementing Ralph in Spur is about
wiring the _loop_, not the per-invocation flags.

### Recipe A: cron + spawn — the native Spur fit

`spawn` triggers are agent-agnostic today (`spawn.agent: claude|codex|cursor`,
see `v2/README.md`'s `weekday-review-spawn` example and the live
`gh-pr-review-spawn` trigger in this repo's `spur.yaml`). A `cron` source
firing a `spawn` trigger on a schedule is the fresh-context Ralph loop:
every tick is a brand-new session in a brand-new worktree, with no
conversation carried over — exactly the property the original bash loop
relies on.

```yaml
sources:
  ralph-tick:
    type: cron
    schedule: "*/30 * * * *" # every 30 min; cap cadence to control cost
    runOnStart: false
triggers:
  ralph-tick-spawn:
    source: ralph-tick
    event: cron:tick
    spawn:
      agent: codex # or claude / cursor
      prompt: >
        Read AGENTS.md and IMPLEMENTATION_PLAN.md. Pick the single
        highest-priority unfinished task. Implement it completely, run
        the project's test/lint/typecheck commands, and only commit once
        they pass. Update IMPLEMENTATION_PLAN.md with what you did and
        what's next. Do not start a second task this run.
```

Prerequisites this puts on the _target_ repo (not on Spur itself):

- `AGENTS.md` — build/test/lint commands + conventions, kept short.
- `IMPLEMENTATION_PLAN.md` — the disk-persisted task list/state. Someone
  (human or a first "plan mode" spawn) has to seed it before the loop starts.
- `specs/*.md` — the requirements the plan is checked against.

What Spur doesn't give you out of the box, and what to decide before turning
this on:

- No hard iteration cap analogous to `--max-iterations` — a cron source ticks
  indefinitely. Cap it either by schedule bounds (business-hours only, N runs/day)
  or by having the plan file itself declare "done" and the prompt check for that
  before doing anything (the loop still spawns, but a no-op iteration is cheap).
- No cost circuit-breaker — this is exactly the "overbaking" risk Huntley warns
  about. Start with a coarse schedule (hourly, not every-minute) and watch the
  first few runs' diffs before tightening it.
- `spawn.autoComplete` does not apply here: `config.ts` only permits it for
  `github:work_item.new`, `sentry:issue.new`, or `github-ci:run.completed`
  events, not `cron:tick` — setting it on a cron-triggered spawn trigger fails
  config load. It also isn't a "which sessions are already live" concept, it's
  one-work-item-per-PR dedup (README's `pr-review-queue-spawn` example is the
  only place it's actually used; the live `gh-pr-review-spawn` trigger in this
  repo uses `spawnDeskGroup` instead, which explicitly rejects `autoComplete`).
  A cron-spawned Ralph iteration needs no equivalent: each tick's session just
  runs to `waiting` and sits idle in its own worktree; the next tick spawns
  another one regardless, so nothing needs to be marked "complete" to unblock
  the loop.

### Recipe B: single-session self-loop — Claude only, lighter weight

This very session is a live example: the `/loop` skill + `ScheduleWakeup` tool
let one Claude session re-invoke itself on an interval or self-paced,
_without_ a fresh worktree or discarded context each time. That's the
"stop-hook, same-session" variant, not the classic fresh-context Ralph — it's
a better fit for polling/monitoring tasks ("check the deploy every 5 min")
than for open-ended implementation work, since context keeps growing and
isn't reset.

Spur has no equivalent primitive for Codex or Cursor sessions today (no
`/loop`-style skill, no self-scheduling wake tool) — for those two agents,
Recipe A (cron + spawn) is the only path, which conveniently is also the
_more faithful_ Ralph implementation per Huntley's own guidance to prefer
fresh context over one growing session.

## Recommendation

If the goal is genuinely autonomous multi-hour/overnight work: use Recipe A.
Pick a target project, seed `AGENTS.md` + `IMPLEMENTATION_PLAN.md` in it, add
a `cron` source + `spawn` trigger to that project's `spur.yaml` block, start
with a coarse schedule (hourly), and read the first few iterations' diffs
before loosening the cadence.

If the goal is a bounded/polling task on an existing session: use the
built-in `/loop` skill (Claude sessions only) — no config changes needed.

Open questions for whoever picks this up next:

- Which project/repo is the actual Ralph target — this decides whether
  `AGENTS.md`/`IMPLEMENTATION_PLAN.md` need to be authored first.
- Preferred agent (codex/cursor/claude) and whether one loop should rotate
  agents per iteration (currently `spawn.agent` is fixed per trigger, so
  agent rotation would need N triggers on the same cron source, or a manual
  edit of `spawn.agent` between runs).
- Where to draw the iteration cap / cost ceiling, since Spur's `cron` source
  has no native run-count limit.

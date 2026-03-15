# Pipeline Flow — What the Agent Sees

## How Steps Work

Each pipeline step sends a **context message** to the agent. The agent receives it as a regular chat message in its terminal session. The message includes:

1. Step ID and current state
2. The step's `prompt:` (instructions)
3. Available `ao` commands

The agent reads the instructions, does the work, then signals completion via `ao done`, `ao fail`, or `ao goto`.

---

## Message Format

When a step starts, the agent receives:

```
## Current Pipeline Step
**Step:** <step-id> (state: running)

<prompt text from config>

### Available Actions
Use `ao` CLI to signal step completion or ask for help:
- `ao done [--output '{"key": "value"}']` -- mark step as completed
- `ao fail [--reason "description"]` -- mark step as failed
- `ao goto <step-id>` -- jump to a specific step
- `ao ask "<question>" [--options "opt1,opt2"]` -- ask the user a question
```

---

## Step-by-Step Examples

### Step: `notify-start`

Agent receives:
```
## Current Pipeline Step
**Step:** notify-start (state: running)

You are the orchestrator. Coordinate work by running subagents...
Run `ao-telegram` skill to notify that the task has started.
Include the task description and session ID.
Wait for the human response via `ao-telegram` get_updates.
If APPROVE → run `ao done`.
If REJECT → run `ao fail --reason "rejected by human"`.

### Available Actions
- `ao done [--output '{"key": "value"}']` ...
```

**Agent actions:**
- Calls `/ao-telegram` skill → sends "Task started: ..." to Telegram
- Calls `/ao-telegram` get_updates → waits for human reply
- Human says "APPROVE" → agent runs `ao done`
- Human says "REJECT" → agent runs `ao fail --reason "rejected by human"`

**Outcomes:**
| Human reply | Agent command | Pipeline result |
|---|---|---|
| APPROVE | `ao done` | → advance to `shallow-scoring` |
| REJECT | `ao fail --reason "rejected"` | → pipeline fails (or pauses per recovery) |
| No reply (30m) | timeout | → auto-fail |

---

### Step: `shallow-scoring`

Agent receives prompt about running `ao-shallow-scoring` skill.

**Agent actions:**
- Runs the `/ao-shallow-scoring` skill (pure reasoning, no tools, < 5s)
- Gets a score 1-5
- Runs: `ao done --output '{"score": 3, "needsResearch": true}'`

**Output matters:** The `needsResearch` field controls whether the `research` step runs (via `when: "{{steps.shallow-scoring.output.needsResearch}}"`).

| Score | needsResearch | Next step |
|---|---|---|
| 1 | false | `research` skipped → `planning` |
| 2-5 | true | `research` runs |

---

### Step: `research` (conditional)

Only runs if `{{steps.shallow-scoring.output.needsResearch}}` is truthy.

Agent receives prompt to run `researcher` + `critic` agents.

**Agent actions:**
- Spawns `researcher` subagent → gets 2-3 approaches with codebase evidence
- Spawns `critic` subagent → evaluates, scores, selects best approach
- Runs: `ao done --output '{"approach": "Use adapter pattern to..."}'`

**If skipped** (score = 1): step state becomes `skipped`, pipeline jumps to `planning`.

---

### Step: `implementation`

Agent receives prompt to run 1-10 `developer` agents.

**Agent actions:**
- Reads the plan from planning step
- Spawns N `developer` subagents, each focused on a part of the plan
- Waits for all to complete
- Checks which files were changed
- Runs: `ao done --output '{"touchesUI": true}'`

**Output controls downstream:** `touchesUI` determines whether `design-review` and `ui-testing` steps run.

**Retry scenario (maxIterations: 10):**
- If agent runs `ao fail` → pipeline may retry depending on recovery config
- With `goto implementation`, the agent re-enters the step (iterations counter increments)
- After 10 iterations → forced fail

---

### Step: `simplify`

Agent receives prompt to run `code-simplifier` agent.

**Agent actions:**
- Spawns `code-simplifier` subagent on recently modified files
- Simplifier removes overheads, consolidates logic, improves readability
- Runs: `ao done`

**If fails (recovery: skip):** step skipped, pipeline continues to `review`.

---

### Step: `open-pr`

Agent receives prompt to open a PR.

**Agent actions:**
- Runs `/github` skill to create PR
- Gets PR URL from output
- Runs: `ao done --output '{"pr_url": "https://github.com/org/repo/pull/42"}'`

**Output used later:** `{{steps.open-pr.output.pr_url}}` interpolated into `notify-completion` step.

---

### Step: `fix-pr-issues` (event-driven)

This step has `on:` handlers — it reacts to external events detected by the poll loop:

```yaml
on:
  ci:failed: "goto fix-pr-issues"
  review:changes-requested: "goto fix-pr-issues"
  review:comments: "goto fix-pr-issues"
```

**Flow:**

1. Agent receives the step prompt, starts fixing known issues
2. Lifecycle poll loop detects CI failed → fires `ci:failed` event
3. Pipeline `tick()` evaluates `on:` handlers on current step
4. Handler `"goto fix-pr-issues"` restarts the step (iteration++)
5. Agent receives the step context again with fresh instructions
6. Agent fixes CI, pushes, runs `ao done`
7. But then review comments arrive → `review:comments` event fires
8. Handler restarts the step again
9. Agent addresses comments, pushes, runs `ao done`
10. No more events → step completes → pipeline advances

**De-duplication:** Each `on:` event fires **at most once per step iteration**. If `ci:failed` already triggered a restart, it won't trigger again until the step starts a new iteration. This prevents infinite restart loops.

**Catch-up:** When a step starts, the pipeline immediately evaluates current state. If CI was *already* failed before the step started listening, the handler fires on the first tick — no events are missed.

---

## Event-Driven Flow Diagram

```
                  Poll Loop
                     │
         ┌───────────┴───────────┐
         │  determineStatus()    │
         │  → ci_failed          │
         │  → changes_requested  │
         │  → has merge conflict │
         │  → new review comments│
         └───────────┬───────────┘
                     │
              Build events map:
              { "ci:failed": true,
                "review:comments": true }
                     │
              ┌──────┴──────┐
              │  tick()     │
              │  on current │
              │  step only  │
              └──────┬──────┘
                     │
         ┌───────────┴───────────┐
         │ Match on: handlers    │
         │ Skip if already fired │
         │ on this step          │
         └───────────┬───────────┘
                     │
              ┌──────┴──────┐
              │ Action:     │
              │ done/fail/  │
              │ goto/send/  │
              │ pause       │
              └──────┬──────┘
                     │
           Step advanced?
           ┌────┴────┐
          yes        no
           │          │
      Re-tick with    done
      same events
      (catch-up)
```

---

## Channel Steps (Human-in-the-Loop)

Channel steps pause the pipeline and wait for external input.

### Example: Telegram approval

```yaml
- id: approval
  channel: telegram
  message: "Ready for review. Approve or reject?"
  options: ["APPROVE", "REJECT"]
  timeout: 30m
```

Agent receives:
```
## Current Pipeline Step
**Step:** approval (state: running)

Ready for review. Approve or reject?

### Options
- APPROVE
- REJECT

### How to Respond
- `ao done --output '{"response": "<your-choice>"}'` -- answer the question
```

**Flow:**
1. Agent sends the message to Telegram
2. Human replies "APPROVE"
3. External system calls `ao respond <session-id> "APPROVE"`
4. Pipeline records response as step output and advances

---

## `on:` Handler Actions

| Handler value | What happens |
|---|---|
| `"done"` | Complete the current step, advance to next |
| `"fail"` | Fail the current step |
| `"pause"` | Pause the pipeline (human intervention needed) |
| `"send"` | Send the step's `message:` to the agent |
| `"goto <step-id>"` | Jump to a specific step (restarts it) |
| `"<free text>"` | Send this text as a message to the agent |
| `{ send: "msg", retries: N, goto: "id" }` | Send message; after N retries, jump to step |

---

## Conditional Steps (`when:`)

Steps can be conditionally skipped based on previous step output:

```yaml
- id: research
  when: "{{steps.shallow-scoring.output.needsResearch}}"

- id: design-review
  when: "{{steps.implementation.output.touchesUI}}"
```

**Evaluation rules:**
- `{{...}}` templates are interpolated from step outputs
- Unresolved `{{...}}` (missing data) → falsy → step skipped
- Empty string, "false", "0", "null", "undefined" → falsy → step skipped
- Anything else → truthy → step runs

---

## Recovery Strategies

When a step fails:

| Recovery | Behavior |
|---|---|
| `fail` (default) | Pipeline stops. Session marked failed. |
| `skip` | Skip the failed step, advance to next. |
| `pause` | Pipeline paused. Human runs `ao goto` or `ao done` to resume. |

Set per-step or pipeline-wide:
```yaml
pipeline:
  recovery: pause       # default for all steps
  steps:
    - id: review
      recovery: skip    # override for this step
```

---

## Iteration Limits

**Per-step:** `maxIterations` limits how many times a step can restart (via `goto` or retry). Each `goto` back to the same step increments the counter. Useful for preventing infinite fix loops.

**Pipeline-wide:** `maxIterations` on the pipeline counts every `tick()` call across all steps. Safety net against runaway pipelines.

```yaml
pipeline:
  maxIterations: 50          # total ticks before force-fail
  steps:
    - id: fix-pr-issues
      maxIterations: 10      # max 10 restarts of this step
```

---

## Full Scenario: Simple Task (score = 1)

```
1. notify-start     → agent sends Telegram, human approves      → ao done
2. shallow-scoring  → score 1, no research needed                → ao done --output '{"score":1,"needsResearch":false}'
3. research         → SKIPPED (when: falsy)
4. planning         → architect creates plan                     → ao done
5. questions        → no questions needed                        → ao done
6. implementation   → 1 developer agent, backend only            → ao done --output '{"touchesUI":false}'
7. simplify         → code-simplifier cleans up                  → ao done
8. review           → reviewer approves                          → ao done
9. design-review    → SKIPPED (touchesUI: false)
10. ui-testing      → SKIPPED (touchesUI: false)
11. open-pr         → PR created                                 → ao done --output '{"pr_url":"..."}'
12. notify-completion → sends PR link to Telegram                → ao done
13. fix-pr-issues   → waits for events, CI passes, no comments   → ao done
```

## Full Scenario: Complex UI Task (score = 4)

```
1. notify-start     → agent sends Telegram, human approves      → ao done
2. shallow-scoring  → score 4, needs research                   → ao done --output '{"score":4,"needsResearch":true}'
3. research         → researcher + critic find best approach     → ao done --output '{"approach":"..."}'
4. planning         → architect creates detailed plan            → ao done
5. questions        → agent asks 2 questions via Telegram        → ao done
6. implementation   → 5 developer agents, UI touched            → ao done --output '{"touchesUI":true}'
7. simplify         → code-simplifier reduces complexity         → ao done
8. review           → reviewer requests changes                 → developer fixes → re-review → approved → ao done
9. design-review    → designer requests layout fix              → developer fixes → approved → ao done
10. ui-testing      → tester passes                              → ao done
11. open-pr         → PR created                                 → ao done --output '{"pr_url":"..."}'
12. notify-completion → sends summary to Telegram                → ao done
13. fix-pr-issues   → CI fails → goto fix-pr-issues (restart)
                    → agent fixes CI, pushes
                    → review comments arrive → goto fix-pr-issues (restart)
                    → agent addresses comments
                    → all green                                  → ao done
```

## Full Scenario: Fix Loop with Retry Exhaustion

```
13. fix-pr-issues (iteration 1)  → CI fails → on:ci:failed → goto fix-pr-issues
13. fix-pr-issues (iteration 2)  → agent fixes, pushes → CI fails again → goto fix-pr-issues
13. fix-pr-issues (iteration 3)  → agent tries different approach → CI still fails → goto
...
13. fix-pr-issues (iteration 10) → maxIterations reached → step fails
                                 → recovery: pause → pipeline paused
                                 → human notified via Telegram
                                 → human runs `ao goto fix-pr-issues` to retry
                                    or `ao done` to force-complete
```

---

## Event Timing Guarantees

### No missed events (catch-up ticking)

When a step starts, the pipeline immediately evaluates current session state. Pre-existing conditions are caught:

```
Timeline:
  t=0   CI fails (status → ci_failed)
  t=10  Step "open-pr" completes → advance to "fix-pr-issues"
  t=10  fix-pr-issues starts, on: ci:failed defined
  t=10  Catch-up tick: ci:failed is TRUE → handler fires immediately
```

Without catch-up, the agent would wait until the next poll cycle (up to 30s) to discover CI was already broken.

### No duplicate events (firedOn tracking)

Each `on:` event fires at most once per step iteration:

```
Timeline:
  t=0   fix-pr-issues starts, ci:failed detected → handler fires
  t=10  Next poll: ci still failed → ci:failed still TRUE
        BUT firedOn includes "ci:failed" → handler skipped
  t=20  Agent runs `ao goto fix-pr-issues` → step restarts (new iteration)
        firedOn reset → ci:failed can fire again if still true
```

### Events only affect current step

`on:` handlers are evaluated **only on the current step**. If `review:comments` arrives while the agent is on step `implementation`, no handler fires — the event will be caught when `fix-pr-issues` eventually starts (via catch-up).

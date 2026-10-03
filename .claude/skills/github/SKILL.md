---
name: github
description: Work with GitHub via gh CLI — create PRs, manage issues, review diffs, check CI status.
model: inherit
allowed-tools: Read, Grep, Glob, Bash
---

GITHUB OPERATIONS VIA gh

ISSUE PRIORITY

  Triage created/reopened issues and every open worker candidate from current body/comments, relevant source/docs, and reproduction or concrete evidence.
  Compare expected vs actual supported behavior; stale labels and report wording do not prove defects.
  Classify bug: broken supported behavior; enhancement: new or changed behavior. Apply bug/enhancement labels; mixed reports get both.
  Preserve unrelated labels; remove type labels only when evidence disproves classification.
  Decide: confirmed actionable bug, feature awaiting human, needs evidence, or evidenced closure.
  Keep uncertain reports open and ineligible for automatic work; missing reproduction alone does not justify closure.
  Assign exactly one label: priority:critical, priority:medium, priority:low.
  Judge body/comments by impact, scope, and workaround; never title, age, or effort alone.
  critical  Reported secret exposure, unrecoverable data loss, or outage blocking core workflows across users without safe workaround.
  medium    Reproducible workflow failure, incorrect state/delivery/lifecycle, recurring CI failure, or measured resource degradation; scoped impact or workaround exists.
  low       Docs, enhancements, refactors, telemetry, cosmetic/recoverable nuisance, or mechanisms without demonstrated workflow impact.
  Promote enhancements only with documented measurable core blockage meeting critical/medium criteria.
  Keep uncertainty low until impact evidence supports promotion.
  Keep valid priority unless new evidence changes classification.
  Read current state before mutation; skip closed issues.
  Remove competing priority labels; verify exactly one remains and type labels match evidence.
  Leave failed classification/write ineligible for automatic spawn.

  LABELS
    priority:critical  B60205  Secret exposure, unrecoverable loss, or core outage without workaround
    priority:medium    FBCA04  Workflow failure or measured degradation with scoped impact or workaround
    priority:low       808080  Docs, enhancements, cleanup, or nuisance without demonstrated workflow impact

ISSUE DISPOSITION

  Close only with evidence: duplicate/canonical report, already fixed/implemented, intended supported behavior, obsolete report, or rejected unsupported/out-of-scope proposal with concrete costs/impact.
  Keep valid low-impact bugs open with priority:low; low priority alone does not justify rejection.
  Keep valid enhancements open for human selection; permit evidenced closure for redundant/implemented/rejected enhancements.
  Recheck current issue state; post concise reason/evidence and canonical issue/doc link before closing.
  Require successful comment and label writes before closure or spawn.
  Use completed for existing resolution; not_planned for invalid, duplicate, or rejected proposal.

ISSUE WORKERS

  Repeat ISSUE PRIORITY and ISSUE DISPOSITION against current report before selecting work and before worker edits.
  Auto-select only confirmed actionable bugs labeled bug with exactly one priority:critical or priority:medium; critical first.
  Require explicit human selection/approval for specific feature; priority, labels, capacity, or old assignment grant none.
  Constrain mixed-report automatic work to verified bug portion; split feature backlog or state separate human-owned feature scope.
  Preserve live-session dedup; recheck state, evidence, type, priority, and scope immediately before spawn.
  Skip closed, uncertain, downgraded, or failed-write candidates; leave slots empty without eligible bugs.

CLOSE-OUT GATE, mandatory after any code change

  Keep close-out PRs OPEN and non-draft. Never create or convert to draft.

  1  Branch main/master/empty -> SKIPPED.
  2  Uncommitted files -> route to developer for commit. Never auto-commit here.
  3  Implementation diff from branch base empty -> SKIPPED.
  4  git push -u origin "$(git branch --show-current)"
  5  gh pr view succeeds -> mark drafts ready; confirm OPEN, non-draft; comment HEAD SHA. Fails -> CREATE OPEN PR.
  6  Problem parked out of scope during the task -> file it per ISSUE REPORTING below.
  7  Return the PR url, plus any issue url filed at step 6.

PR TITLE: <type>: <description>. Types incl. style, no version bump. AO_ISSUE_ID set, prefix: <ISSUE-ID>: <type>: <description>.

PR BODY: plain language, what got fixed and why. Two to four lines, no headings.

  Banned: file paths, symbol names, code, diff stats, test checklist, reasoning, design talk.
  Reader wants the effect, not the diff. Detail belongs in the diff and the commits.
  Closes line only when a real issue number exists.

  Bad:   Dropped the Default sentinel in resolveAgentLaunchModel, added 3 vitest cases.
  Good:  Spawn dropdown now shows the model that actually launches. Before it could
         show one model and start another.

CREATE OPEN PR

  git push -u origin HEAD

  gh pr create \
    --title "<type>: <description>" \
    --body "$(cat <<'EOF'
<what changed, one or two sentences>
<why it was needed, one sentence>

Closes #<issue-number>
EOF
)"

ISSUE REPORTING, for a problem outside the current request

  1  `gh issue list --state all --search "<keywords>"` — search open and closed, never open only.
  2  Open match wins over a closed one: `gh issue comment` the new evidence onto it. Never open a duplicate.
  3  Closed match, none open: `gh issue reopen`, then comment new evidence and triage per ISSUE PRIORITY.
  4  No match: `gh issue create`. State what breaks, where (`file:line`), reproduction, and source PR/task; triage per ISSUE PRIORITY.

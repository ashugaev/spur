---
name: pr-comments-fix
description: Fetch PR review comments, evaluate each critically, fix valid ones, reject wrong suggestions. Use when asked to check PR comments, fix review feedback, or handle PR review.
---

# PR Comments Fix

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/pr-info.sh` | PR number, title, URL, branch, state |
| `scripts/fetch-comments.sh` | Review threads with thread_id, resolved status, diff hunks |
| `scripts/fetch-issue-comments.sh` | Issue-level (non-inline) comments |
| `scripts/reply-comment.sh <comment_id> <body>` | Reply to inline comment |
| `scripts/resolve-thread.sh <thread_id>` | Resolve a review thread |

All scripts auto-detect repo and PR from current branch.

## Workflow

1. **Fetch:**
   ```bash
   bash .claude/skills/pr-comments-fix/scripts/pr-info.sh
   bash .claude/skills/pr-comments-fix/scripts/fetch-comments.sh
   ```

2. **Evaluate each comment:**
   - Read file + surrounding code for full context
   - Classify:

| Verdict | Action |
|---------|--------|
| Valid bug | Fix it |
| Valid concern, wrong fix | Fix your way, explain |
| Wrong/incorrect | Skip with reasoning |
| Stylistic nitpick | Skip unless matches project rules |
| Already fixed | Skip, note it |

3. **Apply fixes** — minimal change, verify no regressions

4. **Reply then resolve:**
   ```bash
   bash .claude/skills/pr-comments-fix/scripts/reply-comment.sh COMMENT_ID "Fixed in <commit>"
   bash .claude/skills/pr-comments-fix/scripts/resolve-thread.sh THREAD_ID
   ```
   Never resolve a thread without replying first. Every thread must have a reply explaining what was done (fixed, rejected with reason, or already fixed). Silent resolves lose context for reviewers.

5. **Self-check — run after all replies are sent:**
   ```bash
   bash .claude/skills/pr-comments-fix/scripts/verify-replies.sh
   ```
   Must print `OK: all N threads have replies and are resolved.`
   If it prints `FAIL` — send missing replies and resolve before finishing.

6. **Report:**
   ```
   ### Fixed
   - [file:line] What was fixed
   ### Rejected
   - [file:line] Why rejected
   ```

## Rules
- Never resolve a thread without replying — always explain what was done
- Never blindly apply suggestions — verify against codebase
- Bot/Copilot comments get extra scrutiny
- If suggestion breaks behavior — reject it
- Prefer own fix over suggested one if better approach exists
- Reply only inside the originating thread — never as a new top-level PR comment
- No follow-up, status, or summary comments on the main PR thread — no self-narration on own PRs
- One reply per thread; multi-item bot reviews get one reply on the originating comment covering each item

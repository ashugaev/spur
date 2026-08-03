---
name: pr-comments-fix
description: Fetch PR review comments, evaluate each critically, fix valid ones, reject wrong suggestions. Use when asked to check PR comments, fix review feedback, or handle PR review.
---

PR COMMENTS FIX

SCRIPTS, auto-detect repo and PR from current branch

  scripts/pr-info.sh                             PR number, title, URL, branch, state
  scripts/fetch-comments.sh                      review threads: thread_id, resolved status, diff hunks
  scripts/fetch-issue-comments.sh                issue-level, non-inline comments
  scripts/reply-comment.sh <comment_id> <body>   reply to inline comment
  scripts/resolve-thread.sh <thread_id>          resolve a review thread

WORKFLOW

  1  bash .claude/skills/pr-comments-fix/scripts/pr-info.sh
     bash .claude/skills/pr-comments-fix/scripts/fetch-comments.sh

  2  Evaluate each comment, read file + surrounding code. Classify:

       Valid bug                  fix it
       Valid concern, wrong fix   fix your way, explain
       Wrong/incorrect            skip with reasoning
       Stylistic nitpick          skip unless matches project rules
       Already fixed              skip, note it

  3  Apply fixes. Minimal change, verify no regressions.

  4  bash .claude/skills/pr-comments-fix/scripts/reply-comment.sh COMMENT_ID "Fixed in <commit>"
     bash .claude/skills/pr-comments-fix/scripts/resolve-thread.sh THREAD_ID

  5  bash .claude/skills/pr-comments-fix/scripts/verify-replies.sh
     Must print: OK: all N threads have replies and are resolved.
     FAIL: send missing replies and resolve before finishing.

  6  Report:

       Fixed
         file:line   what was fixed
       Rejected
         file:line   why rejected

RULES

  Never resolve a thread without replying, always explain what was done.
  Never blindly apply suggestions, verify against codebase.
  Bot/Copilot comments get extra scrutiny.
  Suggestion breaks behavior -> reject it.
  Prefer own fix over suggested one when a better approach exists.
  Reply only inside the originating thread, never as a new top-level PR comment.
  No follow-up, status, or summary comments on the main PR thread, no self-narration on own PRs.
  One reply per thread; multi-item bot reviews get one reply on the originating comment covering each item.

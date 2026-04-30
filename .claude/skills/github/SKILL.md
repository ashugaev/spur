---
name: github
description: Work with GitHub via gh CLI — create PRs, manage issues, review diffs, check CI status.
model: inherit
allowed-tools: Read, Grep, Glob, Bash
---

# GitHub Operations via `gh`

## Default close-out

- Existing PR on the current branch -> commit and push to it.
- No PR -> create one after local validation unless the user opts out.

## Auto-push gate

Detect uncommitted state and push to the working branch. Never close a session with uncommitted changes on a tracked branch.

1. `git status --porcelain` empty -> exit, return `SKIPPED`.
2. Current branch is `main`/`master` -> exit, return `SKIPPED` (refuse to auto-commit on protected branches).
3. Stage and commit:
   ```bash
   git add -A
   git commit -m "chore: auto-push wip on $(git branch --show-current)"
   ```
4. Push:
   ```bash
   git push -u origin "$(git branch --show-current)"
   ```
5. PR exists -> add a one-line comment with the new HEAD SHA. No PR -> open a draft via the "Create draft PR" template above.
6. Return `PUSHED` with the commit SHA.

## PR title

Format `<type>: <description>`. Types: `feat`, `fix`, `refactor`, `style`, `docs`, `chore`, `test`. Prefix with `AO_ISSUE_ID` when set: `<ISSUE-ID>: <type>: <description>`.

## Create draft PR

```bash
git push -u origin HEAD

gh pr create --draft \
  --title "<type>: <description>" \
  --body "$(cat <<'EOF'
## Summary
<what changed and why — 2-3 sentences>

## Changes
- <bullet list>

## Testing
- [ ] Lint passes
- [ ] TypeScript compiles
- [ ] Manual verification

Closes #<issue-number>
EOF
)"
```

## Common commands

```bash
gh pr diff                                          # self-review the diff
gh pr checks                                        # CI status
gh pr view --json url,state,title,checks -q .       # PR snapshot
gh pr list
gh pr merge --squash --auto

gh issue list
gh issue view <number>
gh issue create --title "<title>" --body "<body>"

gh pr review --approve
gh pr review --request-changes --body "<feedback>"
gh pr review --comment --body "<comment>"
```

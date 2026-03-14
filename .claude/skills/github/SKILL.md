---
name: github
description: Work with GitHub via gh CLI — create PRs, manage issues, review diffs, check CI status.
model: inherit
allowed-tools: Read, Grep, Glob, Bash
---

# GitHub Operations via `gh`

## Create Draft PR

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

## PR Title Convention

Format: `<type>: <description>`

Types: `feat`, `fix`, `refactor`, `style`, `docs`, `chore`, `test`

If `AO_ISSUE_ID` is set, prefix with it: `<ISSUE-ID>: <type>: <description>`

## Self-review

```bash
gh pr diff
```

Check for leftover debug code, missing error handling, unintended changes.

## Check CI

```bash
gh pr checks
```

## View PR

```bash
gh pr view --json url,state,title,checks -q .
```

## List PRs

```bash
gh pr list
```

## Merge PR

```bash
gh pr merge --squash --auto
```

## Issues

```bash
gh issue list
gh issue view <number>
gh issue create --title "<title>" --body "<body>"
```

## Review

```bash
gh pr review --approve
gh pr review --request-changes --body "<feedback>"
gh pr review --comment --body "<comment>"
```

## Output Format (for PR creation)

```
## PR Created

URL: <pr-url>
Title: <title>
Status: draft

Checks:
- self-review: OK | found issues: <list>
- typecheck: OK | fixed and pushed
```

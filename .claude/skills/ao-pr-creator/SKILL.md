---
name: ao-pr-creator
description: AO pipeline — push branch and create a draft PR with proper template. 
model: inherit
allowed-tools: Read, Grep, Glob, Bash
---

Push branch and create a DRAFT Pull Request.

## Context

Environment variables:
- `AO_ISSUE_ID` — the Jira issue key (e.g. `WEBDEV-1234`)
- `AO_SESSION` — your session ID

---

## Steps

1. Push branch:
   ```bash
   git push -u origin HEAD
   ```

2. Create draft PR:
   ```bash
   gh pr create --draft \
     --title "${AO_ISSUE_ID}: <clear description>" \
     --body "$(cat <<'EOF'
   ## Summary
   <what changed and why — 2-3 sentences>

   ## Changes
   - <bullet 1>
   - <bullet 2>
   - <bullet 3>

   ## Testing
   - [ ] Lint passes
   - [ ] TypeScript compiles
   - [ ] Manual verification done

   ## Screenshots
   <if UI changes, add before/after>

   Closes ${AO_ISSUE_ID}
   EOF
   )"
   ```

3. Self-review diff:
   ```bash
   gh pr diff
   ```
   Check for obvious issues missed.

4. Final typecheck:
   ```bash
   cd front && yarn tsc --noEmit
   ```
   If errors, fix and push again.

6. Get PR URL:
   ```bash
   gh pr view --json url -q .url
   ```

Keep it as a draft

---

## Output format

```
## PR Created

URL: <pr-url>
Title: <title>

Final checks:
- typecheck: OK | fixed and pushed
- self-review: OK | found issues: <list>

Next: CI will run. Monitor for failures.
```

---

## PR Title Convention

Format: `<ISSUE-ID>: <type>: <description>`

Types:
- `feat` — new feature
- `fix` — bug fix
- `refactor` — code restructure
- `style` — formatting
- `docs` — documentation

Examples:
- `WEBDEV-1234: feat: add date filter to reports`
- `WEBDEV-5678: fix: prevent crash on empty data`

---

## After PR

Pipeline monitors:
- CI failures → `ao-ci-fixer` triggered
- Review comments → `ao-review-fixer` triggered

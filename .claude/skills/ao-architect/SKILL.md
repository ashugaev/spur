---
name: ao-architect
description: AO pipeline — research phase + planning. Reads task, generates options if complex, produces implementation plan.
model: inherit
allowed-tools: Read, Grep, Glob, Bash
---

Research the task and produce a concrete implementation plan.

> **Note:** This skill is invoked by the orchestrator only when the task complexity score is **> 1/5**. Trivial tasks (score = 1) skip directly to planning without running this skill.

## Context

Environment variables:
- `AO_ISSUE_ID` — the Jira issue key (e.g. `WEBDEV-1234`)
- `AO_SESSION` — your session ID

---

## Decision: Trivial or Complex?

Read the task. Classify:
- **Trivial**: < 3 steps, single file, no architectural decisions → Skip to Step 3
- **Complex**: multiple approaches exist, trade-offs needed → Do Steps 1-3

---

## Step 1 — Research Options (complex tasks only)

Generate 2-3 implementation approaches:

1. Explore codebase for existing patterns:
   ```bash
   grep -r "KEYWORD" front/src --include="*.tsx" -l
   ```
2. Read relevant files
3. For each option, document:
   - Approach description
   - Pros and cons
   - Complexity (Low/Medium/High)
   - Affected files

Output:
```
## Options for: <task title>

### Option 1: <name>
- Approach: <description>
- Pros: <list>
- Cons: <list>
- Complexity: Low | Medium | High
- Files: <list>

### Option 2: <name>
...
```

---

## Step 2 — Evaluate and Select (complex tasks only)

Score each option (1-5):
1. Feasibility — clean implementation possible?
2. Maintainability — future devs can understand?
3. Risk — what could break?
4. Alignment — matches codebase patterns?
5. Scope — avoids unnecessary changes?

Output:
```
## Evaluation

### Option 1: <name> — Total: <score>
| Criterion | Score | Notes |
|-----------|-------|-------|
...

## Selected: Option <N> — <name>
Reasoning: <why>
```

---

## Step 3 — Create Plan

1. Read AGENTS.md, CLAUDE.md
2. Search for relevant code:
   ```bash
   grep -r "KEYWORD" front/src --include="*.ts" --include="*.tsx" -l
   ```
3. Read key files
4. Check recent dev commits:
   ```bash
   git log origin/dev --oneline -10
   ```

Classify questions:
- **Technical** — answer by reading code
- **Product** — only human can decide

Output:
```
## Plan: <ISSUE-ID> — <title>

### Scope
- Frontend only | touches backend at: <endpoints>

### Affected files
- `front/src/...` — <what changes>

### Implementation steps
1. <step> — <expected outcome>
2. <step> — <expected outcome>
...

### Acceptance criteria
- [ ] <specific, testable criterion>
- [ ] <specific, testable criterion>

### Resolved questions
- <technical question> → <answer from code>

### Risks
- <what could go wrong>

### Open Questions (omit if none)
- <product question>
```

---

## Rules

- Steps must be small — one focused diff each
- Acceptance criteria must be verifiable, not vague
- Technical questions — exhaust code search before listing
- Product questions — only genuine ambiguities
- Stay in frontend scope unless explicitly approved

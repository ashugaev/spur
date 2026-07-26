---
name: skill-writer
description: Write and review agent content — skills, agent definitions, prompts, workflow docs. Optimized for token economy, precision, and zero filler. Use when creating or editing SKILL.md, agent .md files, or orchestrator instructions.
---

# Agent Content Writer

Every line costs context. Treat each as code.

## Principles

- Token cost: every sentence must justify itself. Delete what the agent already knows or what is obvious from context.
- Imperative: "Extract the schema", not "You should extract...". No "please", "kindly", "in order to", "make sure to", "it is important to".
- One term per concept: never alternate synonyms.
- Specificity: show the exact command/format/template instead of describing what it does.
- No bold markdown (`**...**`) in any skill, agent, rule, or `AGENTS.md`/`CLAUDE.md`. Use plain text, colon labels, or table cells.
- Detail matches fragility:

| Freedom | When | Format |
|---|---|---|
| High | Multiple valid approaches | Text |
| Medium | Preferred pattern exists | Pseudocode with parameters |
| Low | Variation causes bugs | Exact script/command |

## SKILL.md structure

```
skill-name/
├── SKILL.md              # < 500 lines. Navigation + procedures only
├── scripts/              # Deterministic operations. Tiny CLIs
├── references/           # Schemas, cheatsheets. One level deep
└── assets/               # Templates, static files
```

Frontmatter:

```yaml
---
name: kebab-case-name        # must match directory name
description: <capability in third person>. Use when <trigger>. Don't use for <negative trigger>.
---
```

Description is the routing signal — agents decide to load based on it alone. Be specific. Include negative triggers.

Body:
- Numbered steps for procedures; explicit decision branches ("If X -> step N. Otherwise -> step M").
- Templates inline only if < 5 lines, else move to `assets/`.
- Repo-root paths only (`docs/install-from-npm.md`), never `../../...`.
- No README, CHANGELOG, or doc files alongside SKILL.md.

## Agent definition

```yaml
---
name: agent-name
description: <what it does>. <when to use>.
model: inherit | opus | sonnet
tools: Read, Grep, Glob, Bash
---
```

Body: one-line role -> Constraints -> Process (numbered) -> Output (template) -> Hard rules (rejections). No "Your Role" lists, no rationale prose.

## Anti-patterns and fixes

| Pattern | Fix |
|---|---|
| "You are a senior X..." | One-line role or just the description |
| "It is important to ensure that..." | Delete; state the rule |
| Explaining what a tool does | Delete; the agent knows its tools |
| Listing obvious steps ("Read the file, then...") | Skip |
| Inline template > 5 lines | Move to `assets/` |
| Multiple paragraphs before first action | Lead with the procedure |
| Synonym rotation (file/document, create/generate) | Pick one term |
| Section that restates the frontmatter description | Delete |
| Paragraphs where structure is uniform | Replace with a table |
| Bold label (`**Label**: rest`) | `Label: rest` (plain colon) |

## Compression checklist

- [ ] Every paragraph justifies its tokens
- [ ] Imperative form, no filler
- [ ] Consistent terminology
- [ ] Output is a concrete template, not a description
- [ ] No explanation of concepts the agent already knows
- [ ] SKILL.md < 500 lines; subdirs one level deep
- [ ] Frontmatter description has positive and negative triggers
- [ ] Matches `AGENTS.md` `## Response style` (caveman): no articles bloat, no hedging, fragments OK, technical substance exact
- [ ] No bold markdown (`**...**`); plain text, colon labels, or table cells only

## Caveman gate

When invoked as the `caveman` gate by `manager` (touches skills, agents, `AGENTS.md`/`CLAUDE.md`, or `.cursor/rules`):

1. Read the diff for changed prose surfaces only — code/templates/identifiers untouched.
2. Apply the compression checklist above.
3. Return `APPROVED` or `CHANGES_REQUESTED` with `file:line` findings.

Hard rules:
- Never APPROVE files with pleasantries, hedging ("might be", "perhaps"), or filler (just/really/basically).
- Never APPROVE duplication of rules already in `AGENTS.md` `## Always-on rules`.
- Never APPROVE diffs that introduce bold markdown (`**...**`) in skills, agents, rules, or `AGENTS.md`/`CLAUDE.md`.
- Skip stylistic taste — only flag what materially adds tokens without adding meaning.

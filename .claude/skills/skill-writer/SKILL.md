---
name: ao-skill-writer
description: Write and review agent content — skills, agent definitions, prompts, workflow docs. Optimized for token economy, precision, and zero filler. Use when creating or editing SKILL.md, agent .md files, or orchestrator instructions.
---

# Agent Content Writer

Write content that agents consume — skills, agent definitions, prompts, workflow configs.
Every token competes for context window space. Treat each line as code, not prose.

## Principles

### 1. Token cost justification
Challenge every sentence: "Does this justify its token cost?"
If the agent already knows it — delete it. If it's obvious from context — delete it.

### 2. Imperative, third-person
Write commands, not descriptions.
- "Extract the schema" — not "You should extract the schema"
- "Run lint" — not "Please run the linting tool"

### 3. No filler
Remove: "please", "kindly", "if you could", "in order to", "make sure to", "it is important to".
Collapse: "thorough and comprehensive" → "thorough". "Each and every" → "each".

### 4. One term per concept
Pick a single term for each concept and use it everywhere. Never alternate between synonyms.

### 5. Specificity over explanation
Show the exact command, format, or template. Don't explain what it does — the agent will figure it out.

### 6. Degrees of freedom
Match instruction detail to task fragility:

| Freedom | When | Format |
|---------|------|--------|
| High | Multiple valid approaches | Text instructions |
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

### Frontmatter
```yaml
---
name: kebab-case-name        # must match directory name
description: <capability in third person>. Use when <trigger>. Don't use for <negative trigger>.
---
```

Description is the routing signal — agents decide to load based on it alone. Be specific. Include negative triggers.

### Body rules
- Step-by-step numbering for procedures
- Decision trees with explicit branches ("If X → step N. Otherwise → step M")
- Templates in `assets/`, not inline (unless < 5 lines)
- Relative paths with forward slashes
- No README.md, CHANGELOG.md, or documentation files

## Agent definition structure

```yaml
---
name: agent-name
description: <what it does>. <when to use>.
model: inherit | opus | sonnet
tools: Read, Grep, Glob, Bash
---
```

### Body rules
- Open with one-line role statement
- Constraints section — non-negotiable rules
- Process section — numbered steps
- Output section — exact format template
- Hard rules — list of rejection criteria
- No "Your Role" bullet lists restating the description
- No explanations of why rules exist

## Writing checklist

Before finalizing any agent content:

- [ ] Every paragraph justifies its token cost
- [ ] No filler words or politeness markers
- [ ] Commands in imperative form
- [ ] Consistent terminology throughout
- [ ] Output format is a concrete template, not a description
- [ ] No explanation of concepts the agent already knows
- [ ] SKILL.md < 500 lines
- [ ] Subdirectories one level deep only
- [ ] Frontmatter description includes positive and negative triggers

## Anti-patterns

| Pattern | Fix |
|---------|-----|
| "You are a senior X specializing in Y" | Skip — set role in one line or description |
| "It is important to ensure that..." | Delete — just state the rule |
| Explaining what a tool does | Delete — agent knows its tools |
| Listing obvious steps ("Read the file, then...") | Skip obvious steps |
| Inline templates > 5 lines | Move to `assets/` |
| Multiple paragraphs before first actionable step | Lead with the procedure |
| "Please", "kindly", "if possible" | Delete |
| Synonym rotation (file/document, create/generate) | Pick one term |

## Compression techniques

When editing existing content:

1. Remove politeness markers and qualifiers
2. Collapse redundant phrases ("in order to" → "to")
3. Replace paragraphs with tables where structure is uniform
4. Replace descriptions with templates/examples
5. Merge related short sections
6. Delete sections that restate the frontmatter description

---
name: skill-writer
description: Write and review agent content — skills, agent definitions, prompts, workflow docs. Optimized for token economy, precision, and zero filler. Use when creating or editing SKILL.md, agent .md files, or orchestrator instructions.
---

AGENT CONTENT WRITER

Every line costs context. Treat each as code.


FORMAT

Markdown file, minimal markdown. Frontmatter is yaml, machinery not style.

  Body is blank lines, two-space indent, UPPERCASE labels. Nothing else.
  Banned in a body: # heading, ** bold, | table, ``` fence, - bullet, emoji.
  Data needing shape: align columns with spaces.
  Short line, drop articles. Command over description of command.
  One screen per file. Longer, split to references/.


PRINCIPLES

  Token cost    every sentence justifies itself. Delete what the agent
                already knows or reads from context.
  Imperative    "Extract the schema", not "You should extract".
                No please, kindly, in order to, make sure to, it is important to.
  One term      never alternate synonyms.
  Specificity   show the exact command or format, not a description of it.

Detail matches fragility:

  many valid approaches    text
  preferred pattern        pseudocode with parameters
  variation causes bugs    exact script or command


SKILL LAYOUT

  SKILL.md      under 500 lines. Navigation and procedure only.
  scripts/      deterministic operations, tiny CLIs
  references/   schemas, cheatsheets. One level deep.
  assets/       templates, static files

  No README, CHANGELOG, or doc file beside SKILL.md.
  Repo-root paths only, never ../../
  Template over 5 lines goes to assets/

Frontmatter, the only yaml:

  name          kebab-case, matches the directory name
  description   capability in third person. Use when <trigger>.
                Don't use for <negative trigger>.

Description is the routing signal. Agents load on it alone.


AGENT DEFINITION

Frontmatter adds:

  model   inherit | opus | sonnet
  tools   Read, Grep, Glob, Bash

Body order: one-line role, constraints, numbered process, output template,
hard rules. No "Your Role" list, no rationale prose.


ANTI-PATTERNS

  "You are a senior X..."               one-line role, or just the description
  "It is important to ensure that..."   delete, state the rule
  Explaining what a tool does           delete, the agent knows its tools
  Listing obvious steps                 skip
  Inline template over 5 lines          move to assets/
  Paragraphs before the first action    lead with the procedure
  Synonym rotation                      pick one term
  Section restating the description     delete
  Bold label                            Label: rest
  Heading, table, or fence in a body    UPPERCASE label, aligned columns


CHECKLIST

  Every paragraph justifies its tokens
  Imperative form, no filler
  Consistent terminology
  Output is a concrete template, not a description
  Nothing explained that the agent already knows
  Under 500 lines, subdirs one level deep
  Description carries positive and negative triggers
  Format law above obeyed


CAVEMAN GATE

Invoked by manager when a diff touches skills, agents, AGENTS.md,
CLAUDE.md, or .cursor/BUGBOT.md.

  1  Read the diff for changed prose only. Code and identifiers untouched.
  2  Apply the checklist.
  3  Return APPROVED or CHANGES_REQUESTED with file:line findings.

Never APPROVE:

  pleasantries, hedging (might be, perhaps), filler (just, really, basically)
  duplication of a rule already in AGENTS.md always-on rules
  a heading, bold, pipe table, or fence introduced into a body

Skip stylistic taste. Flag only what adds tokens without adding meaning.

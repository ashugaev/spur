---
name: skill-writer
description: Write and review agent content — skills, agent definitions, prompts, workflow docs. Optimized for token economy, precision, and zero filler. Use when creating or editing SKILL.md, agent .md files, or orchestrator instructions.
---

AGENT CONTENT WRITER

Every line costs context. Treat each as code.


FORMAT

Markdown file, minimal markdown. Frontmatter is yaml, machinery not style.

  Body is blank lines, two-space indent, UPPERCASE labels.
  Banned in a body: # heading, ** bold, | table, ``` fence, emoji.
  Data needing shape: align columns with spaces.
  One screen per file. Longer, split to references/.

Lists use `-`. Number a list only when the number carries meaning: an
ordered procedure, or a rank a later line refers back to. Unordered set
of rules or options takes `-`, never 1 2 3.

NEVER DUPLICATE WHAT THE AGENT CAN LOOK UP

  An external tool's help is not skill content. Name the tool, state the
  project-specific decision, and stop. The agent runs `<tool> --help`.
  No command catalogue for `gh`, `git`, `aws`, `docker`, `pnpm`.
  A rule file is not a store for code constants. Point at the file that
  defines them. Copy a value in only when no file defines it.
  Same for config keys, schemas, and route lists: reference the doc or the
  source, never restate it. A restated value goes stale silently.
  Keep the overview: what this repo is, where things live, which decision
  is non-obvious. Cut what the agent derives by reading.


Command text is data, not prose. The format law stops at it.

  One command per line. Never join two commands with a separator.
  Copy-pasteable block keeps its own whitespace. A heredoc terminator
  sits at column 0 and stays there, unindented, fence or no fence.
  Reformatting a command is a defect even when the prose around it improves.


CAVEMAN, HARD

Verb first. Number over adjective. One rule per line.

  Drop articles a, an, the wherever sense survives.
  Drop copulas where a colon or a column carries the meaning.
  Say the number, not the adjective. "under 200 lines", never "large".
  Name the command, never describe the command.

Banned outright:

  hedges       might, may, could, generally, typically, usually, often,
               tends to, in most cases, as needed, where appropriate
  degree       very, quite, fairly, rather, really, simply, just
  meta         note that, keep in mind, remember, be aware, it is worth,
               this means, in other words
  justifying   because, since, in order to, so that, this allows, which
               enables, the reason
  transitions  however, moreover, additionally, furthermore, overall
  courtesy     please, kindly, make sure to, it is important to

Deletion test, apply to every sentence: cut it, reread the file. No
instruction changed, it stays cut.

Grep before returning:

  grep -niE 'because|in order to|note that|keep in mind|it is important|might|may |could |generally|typically|usually|simply|just |very |really' <file>


PRINCIPLES

  Token cost    every sentence justifies itself. Delete what the agent
                already knows or reads from context.
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

  Every sentence survives the deletion test
  Verb first, no banned word from CAVEMAN, HARD
  Consistent terminology
  Output is a concrete template, not a description
  Nothing explained that the agent already knows
  Under 500 lines, subdirs one level deep
  Description carries positive and negative triggers
  FORMAT law obeyed, grep clean


CAVEMAN GATE

Invoked by manager when a diff touches skills, agents, AGENTS.md,
CLAUDE.md, or .cursor/BUGBOT.md.

  1  Read the diff for changed prose only. Code and identifiers untouched.
  2  Run the CAVEMAN, HARD grep on every changed file.
  3  Apply the checklist.
  4  Return APPROVED or CHANGES_REQUESTED with file:line findings.

Never APPROVE:

- a banned word from CAVEMAN, HARD
- a sentence that passes the deletion test
- duplication of a rule already in AGENTS.md always-on rules
- an external tool's help text, or a code constant a source file defines
- a heading, bold, pipe table, or fence in a body

One grep hit is CHANGES_REQUESTED. No taste calls, no warnings-only pass.

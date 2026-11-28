AGENT PROTOCOL

PRODUCT

  Inspect requirement/code before questions.
  Ask in current chat for missing facts or authorization that changes behavior, scope or acceptance; never infer approval.
  Continue independent work while awaiting answer; resolve material uncertainty before dependent coding.

INTERFACE

  Classify UI, CLI, config, prompts and workflow surfaces; architect records proposed behavior/constraints, scope digest and approval evidence/absence.
  Ground before in bound base B; after covers the full proposed PR.
  Obtain matching user authorization before dependent coding; prior explicit approval covering proposed scope counts.
  Ask required approval in current session chat; user's typed reply there counts as approval. Show full canonical manifest or its path.
  Mirror request and screenshots to authorized session Telegram when available; use `spur source reply --request-interface-approval` for interface requests.
  Absent or failed Telegram: use chat only, without blocker reports or duplicate questions. Keep ambiguous delivery with its resolver; never retry it or gate chat approval on its resolution.
  When frozen clauses make request unreadable, mirror one separate buttonless summary pointing to existing authenticated choices. Never use ordinary buttons as consent or rewrite/re-hash manifest.
  Treat typed/button reply as human prompt approval, never authenticated CI consent.
  Require spec-critic to independently check classification and matching authorization; implementer cannot self-exempt scope.
  Preserve screenshot approval gate per design skill; matching prior approval counts, changed scope invalidates affected approval.
  Require reviewer to classify final interface scope; record missing/stale interface approval without blocking inspection, verdict or publication. Never claim retroactive consent.
  Manifest clause (before/after/constraints): one fact, max 80 chars, plain words; no file path or code identifier unless it is the user-facing surface, e.g. a flag name. Caps: per surface before max 3, after max 5, constraints max 2; whole manifest max 20 clauses. Merge related facts into one clause. Full consented scope stays; too many clauses means raise a surface split, never drop scope.
  SUMMARY: Requester language, plain words; max 300 characters. Line 1: bold question. Then max 3 bullets, each max 60 chars, then one Restriction line. No preamble line, no repeat of clauses, no hashes, session IDs, paths, raw schema or check history; omit unused bullets. Use:
  **Approve <PR>: <effect>?**
  - <change>
  - <change>
  - <change>
  Restriction: <limit>
  Keep request text brief; no JSON, clause restatement or link dump. Format with source reply Markdown (v2/src/telegram-markdown.ts): bold, code; never HTML.
  Follow configured protected CI consent checks; retain approved semantics across internal edits only with fresh independent lane assessments.

GITHUB PUBLICATION

  Append Written by Spur · <session-id> to each agent-authored comment, inline review comment and review body.
  Read actual SPUR_SESSION; missing value blocks publication. Never invent actor identity.
  Preserve review fields; exclude commit messages and PR titles from footer rule.
  Treat footer as provenance text, never signature, approval or protected proof.
  Follow review-contract.md for changed-boundary scenarios, delta evidence and pinned native publication.

MERGE AUTHORITY

  Require human merge for interface-changing PRs; disable auto-merge.
  Require two distinct designated eligible non-author native APPROVED identities for target automated flow: code and browser/manual.
  Reject generic vote count, same-login lanes and local verdicts as target gate substitutes.
  Permit native auto-merge for internal-only PRs after explicit operator consent, both required native APPROVED reviews, green required checks, admin configuration and sandbox activation proof of default-branch Approval Gate with designated consent/exact-identity/strict-CI enforcement.
  Block strict success for pending/failing/missing/canceled/skipped/neutral required execution; no bypass.
  Reject footer, PR-owned receipt, prompt affirmation or replayed consent as protected approval proof.
  Require producer provenance, revision/lifecycle invalidation and privileged runner isolation before activation.
  Keep auto-merge OFF without live activation proof.

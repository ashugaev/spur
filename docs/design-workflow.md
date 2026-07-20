# Design workflow (Claude Design pre-implementation gate)

Stage 1 spec. Design only — no agent/skill/manager wiring yet (Stage 2).

## 1. Summary

For tasks touching visible `packages/web` UI, a new pre-implementation gate `design-author` runs first (Claude runtime). It authors a UI design in Claude Design (claude.ai/design), exports it to a runtime-neutral local bundle, hard-stops for explicit user approval, then hands the approved design to any coding agent (Claude/Codex/Cursor). Existing `designer` agent stays as the post-implementation UI review gate — distinct role, unchanged.

## 2. Claude Design integration (verified)

- Backend: Claude Design (claude.ai/design). Figma MCP is available but out of scope for this workflow.
- Tool: `DesignSync` MCP (loaded via ToolSearch). Methods: `list_projects`, `get_project`, `create_project`, `list_files`, `get_file`, `finalize_plan`, `write_files`, `delete_files` (+ legacy `register_assets`/`unregister_assets`). Required order: list/read -> `finalize_plan` -> write/delete. Writes need a finalized `planId`; `create_project` and `finalize_plan` prompt for permission.
- Bundled skills (Claude runtime, not in this repo): `/design-login` bootstraps design-system scope; `/design-sync` drives incremental local<->project sync, one component at a time, never wholesale replace.
- A design lives as a design-system project (`type PROJECT_TYPE_DESIGN_SYSTEM`, immutable at creation). Content = self-contained HTML component previews + specs. Cards indexed by each preview's first-line comment `<!-- @dsCard group="..." -->`, compiled to `_ds_manifest.json`, rendered in the Design System pane on claude.ai.
- Verified in this environment: `DesignSync list_projects` works from both the main session and a Task subagent, with design scopes already granted (no permission prompt). Conclusion: the design gate can run as a normal Task subagent; no main-session fallback needed. `/design-login` remains the bootstrap when scopes are absent.
- Existing project to reuse: "Spur Design System" (owned by the user). The gate updates components in this project incrementally rather than creating new projects per task.

## 3. Why exportable / runtime-neutral

Claude Design tools exist only on the Claude runtime, so the design gate must run on Claude. The coding gate must stay runtime-agnostic — user wants any agent (Claude/Codex/Cursor) able to implement. Bridge: the gate exports the design as plain local files (HTML previews + a markdown spec) any agent reads without Claude Design tools. That local bundle is the contract, not the claude.ai project.

## 4. Export contract

Location: `$SPUR_SESSION_ARTIFACTS_DIR/design/` — session-scoped, renders inline in Spur UI, not committed from the worktree.

| File                   | Contents                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `design-spec.md`       | Handoff doc, see below                                                                    |
| `*.html` (one or more) | Self-contained component previews, renderable inline in Spur UI and readable by any agent |

`design-spec.md` sections:

- Design summary
- Claude Design project (name + URL)
- Components: each with states + variants
- Design tokens: reference `packages/web` tokens by name, no hardcoded HEX/RGB (per `frontend-codestyle` skill)
- Layout / responsive notes
- UI states: loading, empty, error, disabled, focus
- Acceptance criteria: visual, testable
- Approval status: `pending` | `approved by user @ <ISO-timestamp>`

Handoff: curator records an "Accepted design" entry in `$SPUR_SESSION_ARTIFACTS_DIR/task-memory.md` pointing at `design-spec.md` with the approval status. Downstream gates (architect, developer, designer) read it there.

## 5. Gate flow in $manager

Trigger: task introduces or changes visible `packages/web` UI.

Position in canonical order:

```
researcher -> critic -> design-author (approval stop) -> architect -> developer -> ...
```

Tier 0/1 (no researcher/critic): `design-author` runs before architect/developer.

`design-author` steps:

1. Read task-memory / spec.
2. `/design-login` if scopes missing.
3. Update/author components in the "Spur Design System" project (`DesignSync` + `/design-sync`).
4. Export bundle to `$SPUR_SESSION_ARTIFACTS_DIR/design/`.
5. Write `design-spec.md`.
6. HARD STOP.

Approval hard-stop: manager must not proceed to architect/developer until the user explicitly approves `design-spec.md`. On stop, ping the user (`telegram` skill) with the project URL and a one-line summary, set the session to await input. Design iterates with the user until approved; approval status then flips to `approved` and the pipeline resumes.

Handoff to coding: architect binds acceptance criteria to the approved `design-spec.md`; developer (any runtime) implements against the exported HTML + spec; existing `designer` reviews the built UI against the approved `design-spec.md` post-implementation.

## 6. Open questions (build carefully)

- Cross-session handoff: `$SPUR_SESSION_ARTIFACTS_DIR` is session-scoped. Fine within one Spur task/session (manager + subagents share the dir). If a different Spur session on another runtime picks up the coding work, artifacts don't transfer automatically — needs a shared/agreed path or committing `design-spec.md`. Unresolved; decide before relying on cross-runtime handoff.
- Approval reliability: hard-stop is an orchestration rule, not enforced by the Spur runtime. Risk of an autonomous run auto-proceeding. Mitigation: explicit manager rule + Telegram ping + await-input.
- Component granularity: `/design-sync` is one-component-at-a-time by design; large UI changes need several sync passes. Keep exports scoped to the components the task touches.

---

Stage 2 (agent + skill + manager wiring) follows this spec.

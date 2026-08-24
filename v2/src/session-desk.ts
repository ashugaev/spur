import type { SessionRecord, SidecarConfig } from "./types.js";

// Shared-desk-workspace helpers (pure, no IO). Desk sibling sessions (same
// `workspaceId`, shared git worktree) delegate shared state — slots/pr,
// artifacts, project sidecars — to the workspace instead of duplicating it
// per sibling. Slots and the PR binding live in their own
// `workspaces/<workspaceId>.json` file (see workspace-store.ts); artifacts
// and project sidecars are still keyed by the workspace id directly. See
// docs/configuration.md for the desk-group model.

// `workspaceId` is written once at session creation
// (session-service.ts resolveWorkspaceReuseContext) and session records are
// never deleted from the store, so it is always a resolvable storage key.
//
// The `?? deskId ?? id` fallback below is the ONLY place in the codebase
// that reads the legacy `deskId` field: it exists so records normalized
// before this migration (on-disk legacy records handled by
// metadata.ts's normalizeSessionRecord) and raw test-fixture records (which
// bypass the normalizer entirely) still resolve to the right owner. All
// other code must read `session.workspaceId` through this accessor, never
// re-derive it.
export function workspaceIdOf(
  session: Pick<SessionRecord, "id" | "workspaceId" | "deskId">,
): string {
  return session.workspaceId ?? session.deskId ?? session.id;
}

// M2 (project sidecars): MCP sidecars (`sidecar.mcp` set, e.g. playwright)
// stay per-session; non-mcp project sidecars are desk-shared and owned by
// the workspace.
export function sidecarOwnerId(
  session: Pick<SessionRecord, "id" | "workspaceId" | "deskId">,
  sidecar: Pick<SidecarConfig, "mcp">,
): string {
  return sidecar.mcp ? session.id : workspaceIdOf(session);
}

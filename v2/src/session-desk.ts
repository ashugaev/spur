import type { SessionRecord, SidecarConfig } from "./types.js";

// Shared-desk-workspace helpers (pure, no IO). Desk sibling sessions (same
// `deskId` = same anchor session id, shared git worktree) delegate shared
// state — slots, artifacts, project sidecars — to the anchor session's
// record instead of duplicating it per sibling. See docs/configuration.md
// for the desk-group model.

// `deskId` is set to the anchor session's own id at creation time
// (session-service.ts resolveWorkspaceReuseContext), and session records are
// never deleted from the store, so the anchor id is always a resolvable
// storage key.
export function deskAnchorId(session: Pick<SessionRecord, "id" | "deskId">): string {
  return session.deskId ?? session.id;
}

// M2 (project sidecars): MCP sidecars (`sidecar.mcp` set, e.g. playwright)
// stay per-session; non-mcp project sidecars are desk-shared and owned by
// the anchor.
export function sidecarOwnerId(
  session: Pick<SessionRecord, "id" | "deskId">,
  sidecar: Pick<SidecarConfig, "mcp">,
): string {
  return sidecar.mcp ? session.id : deskAnchorId(session);
}

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSession } from "./metadata.js";
import { workspaceIdOf } from "./session-desk.js";
import type {
  PrAlertOwner,
  SessionLink,
  SessionPrBinding,
  SessionRecord,
  SessionSlots,
} from "./types.js";

// Workspace-owned state: the subset of a shared-desk-workspace's data that
// used to live inside the owning (anchor) session's own record — slots
// (title/links/tags) and the PR binding. Moving it into its own
// single-writer file removes the multi-writer race on the anchor's record
// file (its own lifecycle writes vs. any sibling's slot writes vs. a
// sidecar's link-publish, all racing readSession-then-writeSession with no
// lock). Nothing else moves: ports, status, tmux ids, etc. stay on the
// session record they always lived on.
export interface WorkspaceState {
  slots?: SessionSlots;
  pr?: SessionPrBinding;
  prAlertOwner?: PrAlertOwner;
}

export type PrAlertOwnership = PrAlertOwner | { state: "unclaimed" | "invalid" };

type WorkspaceDocument =
  | { state: "absent" | "invalid" }
  | { state: "valid"; value: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Shape-check, not just JSON-parse-check. A file whose `slots` is any
// non-slots value (`{"slots": 5}`) parses fine and then throws deep inside
// deriveSessionSlots — which runs in enrichDashboard, inside the dashboard
// cache tick's Promise.all, so one malformed file would stall the tick for
// every session. Anything that does not match the shape is treated as absent.
function parseSlots(value: unknown): SessionSlots | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value["links"])) return undefined;
  const links = value["links"].filter(
    (link): link is SessionLink =>
      isRecord(link) && typeof link["label"] === "string" && typeof link["url"] === "string",
  );
  const title = value["title"];
  const tags = value["tags"];
  const titleSource = value["titleSource"];
  return {
    ...(typeof title === "string" ? { title } : {}),
    links,
    ...(titleSource === "manual" || titleSource === "agent" ? { titleSource } : {}),
    ...(Array.isArray(tags)
      ? { tags: tags.filter((tag): tag is string => typeof tag === "string") }
      : {}),
  };
}

function parsePrBinding(value: unknown): SessionPrBinding | undefined {
  if (!isRecord(value)) return undefined;
  const { number, repo, url } = value;
  if (typeof number !== "number" || typeof repo !== "string" || typeof url !== "string") {
    return undefined;
  }
  return { number, repo, url };
}

function workspaceStateFilePath(dataDir: string, workspaceId: string): string {
  return join(dataDir, "workspaces", `${workspaceId}.json`);
}

function readWorkspaceDocument(path: string): WorkspaceDocument {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isRecord(parsed) ? { state: "valid", value: parsed } : { state: "invalid" };
  } catch (error) {
    return { state: isRecord(error) && error["code"] === "ENOENT" ? "absent" : "invalid" };
  }
}

function parsePrAlertOwner(value: unknown): PrAlertOwner | null {
  if (!isRecord(value)) return null;
  if (
    value["state"] === "owned" &&
    typeof value["sessionId"] === "string" &&
    value["sessionId"].trim()
  ) {
    const ownerRollbackId = value["ownerRollbackId"];
    if (
      ownerRollbackId !== undefined &&
      (typeof ownerRollbackId !== "string" || !ownerRollbackId.trim())
    )
      return null;
    return {
      state: "owned",
      sessionId: value["sessionId"],
      ...(ownerRollbackId !== undefined ? { ownerRollbackId } : {}),
    };
  }
  if (
    value["state"] === "retired" &&
    typeof value["successorWorkspaceId"] === "string" &&
    value["successorWorkspaceId"].trim() &&
    typeof value["successorSessionId"] === "string" &&
    value["successorSessionId"].trim()
  )
    return {
      state: "retired",
      successorWorkspaceId: value["successorWorkspaceId"],
      successorSessionId: value["successorSessionId"],
    };
  return null;
}

export function readPrAlertOwnership(dataDir: string, workspaceId: string): PrAlertOwnership {
  const document = readWorkspaceDocument(workspaceStateFilePath(dataDir, workspaceId));
  if (document.state === "absent") return { state: "unclaimed" };
  if (document.state !== "valid") return { state: "invalid" };
  if (!("prAlertOwner" in document.value)) return { state: "unclaimed" };
  const owner = parsePrAlertOwner(document.value["prAlertOwner"]);
  if (!owner) return { state: "invalid" };
  if (owner.state === "owned") {
    try {
      const session = readSession(dataDir, owner.sessionId);
      if (!session || workspaceIdOf(session) !== workspaceId) return { state: "invalid" };
    } catch {
      return { state: "invalid" };
    }
  }
  return owner;
}

function readWorkspaceStateFile(path: string): WorkspaceState | null {
  const document = readWorkspaceDocument(path);
  if (document.state !== "valid") return null;
  const parsed = document.value;
  let slots = parseSlots(parsed["slots"]);
  const pr = parsePrBinding(parsed["pr"]);
  const prAlertOwner = parsePrAlertOwner(parsed["prAlertOwner"]);
  // Read-path upgrade for records written before `ac484aa0f` (the standalone
  // `manualTitleOverride` marker) was folded into `slots.titleSource`. A live
  // workspace file may still carry the legacy marker with no `titleSource`.
  // `manualTitleOverride` was set ONLY by manual-sourced writes (plain
  // `--title`/`--clear-title`, never agent `--title-if-absent`; see
  // ac484aa0f's `!normalized.setTitleIfAbsent` gate) so it always encoded a
  // real manual lock. Map it to "manual", not "agent" — mapping to "agent"
  // would silently drop a legacy workspace's manual lock.
  if (parsed["manualTitleOverride"] === true && !slots?.titleSource) {
    slots = { ...(slots ?? { links: [] }), titleSource: "manual" };
  }
  return {
    ...(slots ? { slots } : {}),
    ...(pr ? { pr } : {}),
    ...(prAlertOwner ? { prAlertOwner } : {}),
  };
}

export function readWorkspaceState(dataDir: string, workspaceId: string): WorkspaceState | null {
  const path = workspaceStateFilePath(dataDir, workspaceId);
  if (!existsSync(path)) return null;
  return readWorkspaceStateFile(path);
}

// Atomic write: tmp file + rename, same approach as metadata.ts's
// writeJsonFile, so a crash mid-write never leaves a partially-written file
// in place of the real one.
export function writeWorkspaceState(
  dataDir: string,
  workspaceId: string,
  state: WorkspaceState,
): void {
  const current = readPrAlertOwnership(dataDir, workspaceId);
  if (current.state === "invalid") throw new Error("Cannot overwrite invalid PR alert ownership");
  if (current.state !== "unclaimed" && state.prAlertOwner === undefined)
    throw new Error("Workspace writes must retain PR alert ownership");
  const path = workspaceStateFilePath(dataDir, workspaceId);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  const payload: WorkspaceState = {
    ...(state.slots ? { slots: state.slots } : {}),
    ...(state.pr ? { pr: state.pr } : {}),
    ...(state.prAlertOwner ? { prAlertOwner: state.prAlertOwner } : {}),
  };
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

export function deleteWorkspaceState(dataDir: string, workspaceId: string): void {
  rmSync(workspaceStateFilePath(dataDir, workspaceId), { force: true });
}

// The dual-read migration: workspaces/<wsId>.json is authoritative once it
// exists; until then, a workspace's slots/pr resolve exactly as they did
// before this file existed — from the owning session record. Every reader
// of workspace-owned slots/pr must go through this, never re-derive the
// fallback itself.
//
// `record` may be the owner's own record (zero extra IO: the fallback below
// reads straight off it) or any workspace member's record (one extra read
// of the owner, same cost `deskAnchorRecord` already paid for this data
// pre-migration). Passing an already-resolved owner record when the caller
// has one in hand avoids a redundant second read.
export function resolveWorkspaceState(
  dataDir: string,
  record: Pick<SessionRecord, "id" | "workspaceId" | "deskId" | "slots" | "pr">,
): WorkspaceState {
  const workspaceId = workspaceIdOf(record);
  const fileState = readWorkspaceState(dataDir, workspaceId);
  if (fileState) return fileState;
  const owner = record.id === workspaceId ? record : (readSession(dataDir, workspaceId) ?? record);
  return {
    ...(owner.slots ? { slots: owner.slots } : {}),
    ...(owner.pr ? { pr: owner.pr } : {}),
  };
}

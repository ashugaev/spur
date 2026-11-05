// Web boundary for agent-authored snippet files: which artifacts are snippets,
// and whether a file's inline manifest is valid. Pure; no network, no DOM
// beyond the non-executing DOMParser.

import type { SpurSessionArtifact } from "@/lib/types";
import {
  isAllowedSnippetStore,
  isRecord,
  SNIPPET_ACTION_ID_RE,
  SNIPPET_ID_RE,
  SNIPPET_INSTANCE_ID_RE,
  SNIPPET_PROTOCOL_VERSION,
  SNIPPET_RESERVED_RE,
  SNIPPET_TEXT_RE,
} from "./snippet-protocol";
import { parseSnippetSchema, type SnippetObjectSchema } from "./snippet-schema";

export interface SnippetActionDecl {
  id: string;
  label: string;
  payload: SnippetObjectSchema;
  confirm?: "always";
}

export interface SnippetManifest {
  protocolVersion: typeof SNIPPET_PROTOCOL_VERSION;
  snippetId: string;
  ownerSessionId: string;
  instanceId: string;
  revision: number;
  // Data store for spur.db and spur.state; absent = the owning session's store.
  store?: string;
  title: string;
  actions: SnippetActionDecl[];
}

export interface OwnedSnippetArtifact {
  artifact: SpurSessionArtifact;
  snippetId: string;
}

export interface SnippetPartition {
  generic: SpurSessionArtifact[];
  // Owned files, newest first (updatedAt desc, then id). Includes files past the mount cap.
  owned: OwnedSnippetArtifact[];
}

function ownedSlug(artifact: SpurSessionArtifact, sessionId: string): string | null {
  const prefix = `snippet.${sessionId}.`;
  if (!artifact.name.startsWith(prefix) || !artifact.name.endsWith(".html")) return null;
  const slug = artifact.name.slice(prefix.length, -".html".length);
  return SNIPPET_ID_RE.test(slug) ? slug : null;
}

// Reserved root names leave the generic artifact surfaces. Foreign-owner and
// in-flight (.tmp) reserved files are hidden, never mounted.
export function partitionSnippetArtifacts(
  artifacts: readonly SpurSessionArtifact[],
  sessionId: string,
): SnippetPartition {
  const generic: SpurSessionArtifact[] = [];
  const owned: OwnedSnippetArtifact[] = [];
  for (const artifact of artifacts) {
    const isRoot = !artifact.id.includes("/") && artifact.id === artifact.name;
    if (!isRoot || !SNIPPET_RESERVED_RE.test(artifact.name)) {
      generic.push(artifact);
      continue;
    }
    const snippetId = ownedSlug(artifact, sessionId);
    if (snippetId !== null) owned.push({ artifact, snippetId });
  }
  owned.sort((a, b) => {
    const byTime = Date.parse(b.artifact.updatedAt) - Date.parse(a.artifact.updatedAt);
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    return a.artifact.id < b.artifact.id ? -1 : a.artifact.id > b.artifact.id ? 1 : 0;
  });
  return { generic, owned };
}

export type SnippetManifestError =
  | { code: "manifest_invalid"; path: string; message: string }
  | { code: "owner_mismatch"; path: string; message: string };

export type ParsedSnippetManifest =
  | { ok: true; manifest: SnippetManifest }
  | { ok: false; error: SnippetManifestError };

export const SNIPPET_V1_MESSAGE =
  "Snippet protocol 1 is no longer supported; rewrite with protocolVersion 2";

const MANIFEST_SCRIPT_SELECTOR ='script[type="application/spur-snippet+json"]';
const MANIFEST_KEYS = [
  "protocolVersion",
  "snippetId",
  "ownerSessionId",
  "instanceId",
  "revision",
  "store",
  "title",
  "actions",
];
const ACTION_KEYS = ["id", "label", "payload", "confirm"];

function invalid(path: string, message: string): ParsedSnippetManifest {
  return { ok: false, error: { code: "manifest_invalid", path, message } };
}

function validText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    SNIPPET_TEXT_RE.test(value)
  );
}

export function parseSnippetManifest(
  html: string,
  expected: { sessionId: string; snippetId: string },
): ParsedSnippetManifest {
  const script = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector(MANIFEST_SCRIPT_SELECTOR);
  if (!script) return invalid("", "manifest script missing");
  let raw: unknown;
  try {
    raw = JSON.parse(script.textContent ?? "");
  } catch {
    return invalid("", "manifest is not valid JSON");
  }
  if (!isRecord(raw)) return invalid("", "manifest must be an object");
  if (raw.protocolVersion === 1) return invalid("/protocolVersion", SNIPPET_V1_MESSAGE);
  if (raw.protocolVersion !== SNIPPET_PROTOCOL_VERSION) {
    return invalid("/protocolVersion", "protocolVersion must be 2");
  }
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_KEYS.includes(key)) return invalid(`/${key}`, "unknown key");
  }
  if (typeof raw.snippetId !== "string" || !SNIPPET_ID_RE.test(raw.snippetId)) {
    return invalid("/snippetId", "invalid snippetId");
  }
  if (raw.snippetId !== expected.snippetId)
    return invalid("/snippetId", "snippetId differs from file name");
  if (raw.ownerSessionId !== expected.sessionId) {
    return {
      ok: false,
      error: {
        code: "owner_mismatch",
        path: "/ownerSessionId",
        message: "owner differs from this session",
      },
    };
  }
  if (typeof raw.instanceId !== "string" || !SNIPPET_INSTANCE_ID_RE.test(raw.instanceId)) {
    return invalid("/instanceId", "instanceId must match [A-Za-z0-9-]{8,64}");
  }
  const { revision } = raw;
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    revision > 2 ** 31 - 1
  ) {
    return invalid("/revision", "revision must be an integer 1..2147483647");
  }
  if (
    raw.store !== undefined &&
    (typeof raw.store !== "string" || !isAllowedSnippetStore(raw.store, expected.sessionId))
  ) {
    return invalid("/store", "store must be page:<id> or session:<owner>");
  }
  if (!validText(raw.title, 120)) return invalid("/title", "title must be 1..120 plain characters");
  const rawActions = raw.actions;
  if (!Array.isArray(rawActions) || rawActions.length < 1 || rawActions.length > 32) {
    return invalid("/actions", "actions need 1..32 entries");
  }
  const actions: SnippetActionDecl[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of rawActions.entries()) {
    const path = `/actions/${index}`;
    if (!isRecord(entry)) return invalid(path, "action must be an object");
    for (const key of Object.keys(entry)) {
      if (!ACTION_KEYS.includes(key)) return invalid(`${path}/${key}`, "unknown key");
    }
    if (typeof entry.id !== "string" || !SNIPPET_ACTION_ID_RE.test(entry.id)) {
      return invalid(`${path}/id`, "invalid action id");
    }
    if (seen.has(entry.id)) return invalid(`${path}/id`, "duplicate action id");
    seen.add(entry.id);
    if (!validText(entry.label, 80))
      return invalid(`${path}/label`, "label must be 1..80 plain characters");
    if (entry.confirm !== undefined && entry.confirm !== "always") {
      return invalid(`${path}/confirm`, 'confirm must be "always"');
    }
    const schema = parseSnippetSchema(entry.payload, `${path}/payload`);
    if (!schema.ok) return invalid(schema.path, schema.message);
    actions.push({
      id: entry.id,
      label: entry.label,
      payload: schema.schema,
      ...(entry.confirm === "always" ? { confirm: "always" as const } : {}),
    });
  }
  return {
    ok: true,
    manifest: {
      protocolVersion: SNIPPET_PROTOCOL_VERSION,
      snippetId: raw.snippetId,
      ownerSessionId: raw.ownerSessionId,
      instanceId: raw.instanceId,
      revision,
      ...(typeof raw.store === "string" ? { store: raw.store } : {}),
      title: raw.title,
      actions,
    },
  };
}

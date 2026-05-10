import { appendFileSync, copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";

const INPUTS_FILE = "inputs.jsonl";
const ATTACHMENTS_DIR = "attachments";
const SCHEMA_VERSION = 1;

type MetadataValue = string | number | boolean | null;
export type DedicatedInputMetadata = Record<string, MetadataValue>;

export type DedicatedTextInputKind =
  | "spawn_prompt"
  | "send_message"
  | "trigger_send_prompt"
  | "respawn_override_prompt";

export type DedicatedAttachmentInputKind = "spawn_attachment" | "send_attachment";

export interface DedicatedTextInput {
  kind: DedicatedTextInputKind;
  text: string;
  metadata?: DedicatedInputMetadata;
}

export interface DedicatedAttachmentInput {
  kind: DedicatedAttachmentInputKind;
  sourcePath: string;
  name: string;
  metadata?: DedicatedInputMetadata;
}

export function dedicatedStorageDir(dataDir: string, sessionId: string): string {
  return join(dataDir, "dedicated-storage", sessionId);
}

export function ensureDedicatedStorageDir(dataDir: string, sessionId: string): string {
  const dir = dedicatedStorageDir(dataDir, sessionId);
  mkdirSync(join(dir, ATTACHMENTS_DIR), { recursive: true });
  return dir;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeAttachmentName(name: string): string {
  const base = basename(name).replace(/[^\w.-]/g, "_");
  return base || "attachment";
}

function appendInputRecord(
  dataDir: string,
  sessionId: string,
  record: Record<string, unknown>,
): void {
  const storageDir = ensureDedicatedStorageDir(dataDir, sessionId);
  appendFileSync(join(storageDir, INPUTS_FILE), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}

export function appendDedicatedTextInput(
  dataDir: string,
  sessionId: string,
  input: DedicatedTextInput,
): void {
  const text = input.text.trim();
  if (!text) {
    return;
  }
  appendInputRecord(dataDir, sessionId, {
    schemaVersion: SCHEMA_VERSION,
    id: randomUUID(),
    createdAt: nowIso(),
    type: "text",
    kind: input.kind,
    text,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export function appendDedicatedAttachmentInput(
  dataDir: string,
  sessionId: string,
  input: DedicatedAttachmentInput,
): string {
  const storageDir = ensureDedicatedStorageDir(dataDir, sessionId);
  const safeName = safeAttachmentName(input.name);
  const extension = extname(safeName);
  const id = randomUUID();
  const storedName = `${id}${extension}`;
  const relativePath = join(ATTACHMENTS_DIR, storedName);
  const targetPath = join(storageDir, relativePath);
  copyFileSync(input.sourcePath, targetPath);
  const bytes = statSync(targetPath).size;
  const sha256 = createHash("sha256").update(readFileSync(targetPath)).digest("hex");
  appendInputRecord(dataDir, sessionId, {
    schemaVersion: SCHEMA_VERSION,
    id,
    createdAt: nowIso(),
    type: "attachment",
    kind: input.kind,
    name: safeName,
    relativePath,
    size: bytes,
    sha256,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return targetPath;
}

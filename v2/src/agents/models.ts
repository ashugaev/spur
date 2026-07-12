import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CURSOR_MODEL, cursorCommand } from "./cursor.js";
import type { AgentName } from "../types.js";

const execFileAsync = promisify(execFile);

export interface AgentModel {
  id: string;
  label: string;
  isCurrent?: boolean;
}

const CLAUDE_MODELS: AgentModel[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
];

const CODEX_FALLBACK_MODELS: AgentModel[] = [{ id: "gpt-5.5", label: "GPT-5.5" }];

const CURSOR_FALLBACK_MODELS: AgentModel[] = [{ id: "auto", label: "Auto" }];

const CURSOR_CACHE_TTL_MS = 5 * 60 * 1000;

interface CursorCacheEntry {
  models: AgentModel[];
  expiresAt: number;
}

const cursorCache = new Map<string, CursorCacheEntry>();

function codexHomeDir(opts?: { codexHomePath?: string }): string {
  return opts?.codexHomePath ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCodexModelsCache(raw: string): AgentModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return CODEX_FALLBACK_MODELS;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["models"])) {
    return CODEX_FALLBACK_MODELS;
  }
  const models: AgentModel[] = [];
  for (const entry of parsed["models"]) {
    if (!isRecord(entry)) {
      continue;
    }
    if (entry["visibility"] !== "list") {
      continue;
    }
    const slug = entry["slug"];
    if (typeof slug !== "string" || slug.length === 0) {
      continue;
    }
    const displayName = entry["display_name"];
    const label = typeof displayName === "string" && displayName.length > 0 ? displayName : slug;
    models.push({ id: slug, label });
  }
  return models.length > 0 ? models : CODEX_FALLBACK_MODELS;
}

async function listCodexModels(opts?: { codexHomePath?: string }): Promise<AgentModel[]> {
  const cachePath = join(codexHomeDir(opts), "models_cache.json");
  let raw: string;
  try {
    raw = await readFile(cachePath, "utf8");
  } catch {
    return CODEX_FALLBACK_MODELS;
  }
  return parseCodexModelsCache(raw);
}

export function parseCursorModelsOutput(stdout: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(" - ")) {
      continue;
    }
    const separator = trimmed.indexOf(" - ");
    const id = trimmed.slice(0, separator).trim();
    let label = trimmed.slice(separator + 3).trim();
    if (!id) {
      continue;
    }
    let isCurrent = false;
    if (label.endsWith(" (default)")) {
      label = label.slice(0, -" (default)".length).trim();
    }
    if (label.endsWith(" (current)")) {
      isCurrent = true;
      label = label.slice(0, -" (current)".length).trim();
    }
    models.push({
      id,
      label,
      ...(isCurrent ? { isCurrent: true } : {}),
    });
  }
  return models;
}

function isCursorFastModelId(id: string): boolean {
  return id !== "auto" && id.endsWith("-fast");
}

export function pickCursorNormalModelId(models: AgentModel[]): string | undefined {
  const current = models.find((model) => model.isCurrent && !isCursorFastModelId(model.id));
  if (current) {
    return current.id;
  }
  return models.find((model) => model.id !== "auto" && !isCursorFastModelId(model.id))?.id;
}

export async function resolveCursorLaunchModel(model?: string): Promise<string> {
  if (model && model !== DEFAULT_CURSOR_MODEL) {
    return model;
  }
  const models = await listCursorModels();
  return pickCursorNormalModelId(models) ?? model ?? DEFAULT_CURSOR_MODEL;
}

async function listCursorModels(): Promise<AgentModel[]> {
  const cacheKey = cursorCommand();
  const cached = cursorCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(cursorCommand(), ["models"], { encoding: "utf8" }));
  } catch {
    return CURSOR_FALLBACK_MODELS;
  }
  const models = parseCursorModelsOutput(stdout);
  const resolved = models.length > 0 ? models : CURSOR_FALLBACK_MODELS;
  cursorCache.set(cacheKey, { models: resolved, expiresAt: Date.now() + CURSOR_CACHE_TTL_MS });
  return resolved;
}

export async function listAgentModels(
  agent: AgentName,
  opts?: { codexHomePath?: string },
): Promise<AgentModel[]> {
  switch (agent) {
    case "claude":
      return CLAUDE_MODELS;
    case "codex":
      return listCodexModels(opts);
    case "cursor":
      return listCursorModels();
  }
}

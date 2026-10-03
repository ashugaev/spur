import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_CLAUDE_MODEL,
  discoverClaudeModelCapabilities,
  listClaudeModels,
} from "./claude.js";
import { DEFAULT_CURSOR_MODEL, cursorCommand } from "./cursor.js";
import { opencodeCommand, readOpenCodeJson } from "./opencode.js";
import { missingAgentExecutableMessage, resolveAgentExecutable } from "./executable.js";
import type { AgentName, ProviderReasoningEffort } from "../types.js";

const execFileAsync = promisify(execFile);

export interface AgentModel {
  id: string;
  label: string;
  isDefault?: boolean;
  isCurrent?: boolean;
  reasoningEfforts?: ProviderReasoningEffort[];
  variantNames?: string[];
}

export interface AgentModelCatalog {
  models: AgentModel[];
  defaultReasoningEfforts: ProviderReasoningEffort[];
  reasoningError?: string;
}

const REASONING_EFFORTS: ProviderReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const CODEX_COMPATIBILITY_EFFORTS: ProviderReasoningEffort[] = ["low", "medium", "high"];

function orderedEfforts(levels: readonly string[]): ProviderReasoningEffort[] {
  return REASONING_EFFORTS.filter((level) => levels.includes(level));
}

export class AgentReasoningEffortError extends Error {
  readonly statusCode = 400;
}

const CURSOR_FALLBACK_MODELS: AgentModel[] = [{ id: "auto", label: "Auto", isDefault: true }];

const CURSOR_CACHE_TTL_MS = 5 * 60 * 1000;

interface CursorCacheEntry {
  models: AgentModel[];
  expiresAt: number;
}

const cursorCache = new Map<string, CursorCacheEntry>();
// Dedupes concurrent calls (e.g. /api/models and /api/projects/:id/spawn-
// defaults firing near-simultaneously on a cold cache) onto a single
// in-flight `cursor models` exec instead of running it twice in parallel.
// Keyed the same as cursorCache; evicted on both success and failure so a
// rejected call never poisons later callers.
const cursorInFlight = new Map<string, Promise<AgentModel[]>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCodexModelsCache(raw: string, includeHidden = false): AgentModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["models"])) {
    return [];
  }
  const models: AgentModel[] = [];
  for (const entry of parsed["models"]) {
    if (!isRecord(entry)) {
      continue;
    }
    if (!includeHidden && entry["visibility"] !== "list") {
      continue;
    }
    const slug = entry["slug"];
    if (typeof slug !== "string" || slug.length === 0) {
      continue;
    }
    const displayName = entry["display_name"];
    const label = typeof displayName === "string" && displayName.length > 0 ? displayName : slug;
    const levels = entry["supported_reasoning_levels"];
    const reasoningEfforts = Array.isArray(levels)
      ? levels.flatMap((level) =>
          isRecord(level) && isReasoningEffort(level["effort"]) ? [level["effort"]] : [],
        )
      : undefined;
    models.push({
      id: slug,
      label,
      reasoningEfforts: reasoningEfforts
        ? orderedEfforts(reasoningEfforts)
        : CODEX_COMPATIBILITY_EFFORTS,
    });
  }
  return models;
}

async function listCodexModels(
  codexHomePath: string,
  includeHidden = false,
): Promise<AgentModel[]> {
  const cachePath = join(codexHomePath, "models_cache.json");
  let raw: string;
  try {
    raw = await readFile(cachePath, "utf8");
  } catch {
    return [];
  }
  return parseCodexModelsCache(raw, includeHidden);
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
    let isDefault = false;
    let isCurrent = false;
    if (label.endsWith(" (default)")) {
      isDefault = true;
      label = label.slice(0, -" (default)".length).trim();
    }
    if (label.endsWith(" (current)")) {
      isCurrent = true;
      label = label.slice(0, -" (current)".length).trim();
    }
    models.push({
      id,
      label,
      ...(isDefault ? { isDefault: true } : {}),
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

function normalizeCursorDefaultModel(models: AgentModel[]): AgentModel[] {
  if (!models.some((model) => model.id === DEFAULT_CURSOR_MODEL)) {
    return models;
  }
  return models.map((model) => ({
    id: model.id,
    label: model.label,
    ...(model.isCurrent ? { isCurrent: true } : {}),
    ...(model.id === DEFAULT_CURSOR_MODEL ? { isDefault: true } : {}),
  }));
}

async function execCursorModels(cacheKey: string): Promise<AgentModel[]> {
  let stdout: string;
  try {
    // Bounded so a hung `cursor` binary can't leave this (and the HTTP
    // request that awaits it, e.g. /models or /projects/:id/spawn-defaults)
    // unresolved indefinitely. Under the client-facing 8s spurRequest
    // timeout (packages/web/src/lib/spur-daemon.ts) so a stall still
    // resolves here first, into the same graceful fallback as "no cursor
    // CLI", rather than the caller timing out on a still-running process.
    ({ stdout } = await execFileAsync(cursorCommand(), ["models"], {
      encoding: "utf8",
      timeout: 5_000,
    }));
  } catch {
    return CURSOR_FALLBACK_MODELS;
  }
  const models = parseCursorModelsOutput(stdout);
  const resolved = models.length > 0 ? normalizeCursorDefaultModel(models) : CURSOR_FALLBACK_MODELS;
  cursorCache.set(cacheKey, { models: resolved, expiresAt: Date.now() + CURSOR_CACHE_TTL_MS });
  return resolved;
}

async function listCursorModels(): Promise<AgentModel[]> {
  const cacheKey = cursorCommand();
  const cached = cursorCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }
  const inFlight = cursorInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  const request = execCursorModels(cacheKey).finally(() => {
    cursorInFlight.delete(cacheKey);
  });
  cursorInFlight.set(cacheKey, request);
  return request;
}

export function parseOpenCodeModelsOutput(stdout: string): AgentModel[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((id) => /^[^\s/]+\/\S+$/.test(id))
    .map((id) => ({ id, label: id }));
}

export function parseOpenCodeVerboseModelsOutput(stdout: string): AgentModel[] {
  const models: AgentModel[] = [];
  const blocks = /^[^\s/]+\/[^\s]+\r?\n\s*\{/gm;
  for (const match of stdout.matchAll(blocks)) {
    const id = match[0].slice(0, match[0].indexOf("\n")).trim();
    const start = match.index + match[0].lastIndexOf("{");
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < stdout.length; end++) {
      const char = stdout[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}") depth--;
      if (depth !== 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.slice(start, end + 1));
      } catch {
        break;
      }
      if (
        isRecord(parsed) &&
        typeof parsed["providerID"] === "string" &&
        typeof parsed["id"] === "string" &&
        `${parsed["providerID"]}/${parsed["id"]}` === id
      ) {
        const variants = parsed["variants"];
        if (variants === undefined) {
          models.push({ id, label: id, variantNames: [], reasoningEfforts: [] });
          break;
        }
        if (!isRecord(variants) || Array.isArray(variants)) break;
        const variantNames = Object.keys(variants);
        if (
          variantNames.every(
            (key) =>
              key.trim().length > 0 && isRecord(variants[key]) && !Array.isArray(variants[key]),
          )
        ) {
          models.push({
            id,
            label: id,
            variantNames,
            reasoningEfforts: orderedEfforts(variantNames),
          });
        }
      }
      break;
    }
  }
  return models;
}

// `opencode models` takes 3-4s cold, so a 5s budget refuses valid models on a
// loaded host and blocks the spawn. Match the other OpenCode CLI reads.
const OPENCODE_MODELS_TIMEOUT_MS = 20_000;

async function discoverOpenCodeModels(): Promise<AgentModel[]> {
  const stdout = await readOpenCodeJson(["models", "--verbose"], {
    timeoutMs: OPENCODE_MODELS_TIMEOUT_MS,
  });
  return parseOpenCodeVerboseModelsOutput(stdout);
}

function missingOpenCodeExecutableError(error: unknown): Error | null {
  if (resolveAgentExecutable("opencode").path) return null;
  return new Error(missingAgentExecutableMessage("opencode"), { cause: error });
}

async function listOpenCodeModels(): Promise<AgentModel[]> {
  try {
    return await discoverOpenCodeModels();
  } catch (error) {
    const missingExecutable = missingOpenCodeExecutableError(error);
    if (missingExecutable) throw missingExecutable;
    throw new Error(`OpenCode model discovery failed using ${opencodeCommand()}`, { cause: error });
  }
}

export async function validateOpenCodeModel(model: string): Promise<string> {
  let models: AgentModel[];
  try {
    models = await discoverOpenCodeModels();
  } catch (error) {
    const missingExecutable = missingOpenCodeExecutableError(error);
    if (missingExecutable) throw missingExecutable;
    throw new Error(`Cannot validate OpenCode model "${model}": model list unavailable`, {
      cause: error,
    });
  }
  if (models.length === 0) {
    throw new Error(`Cannot validate OpenCode model "${model}": model list is empty`);
  }
  if (!models.some((candidate) => candidate.id === model)) {
    throw new Error(`OpenCode model "${model}" is not available`);
  }
  return model;
}

function isReasoningEffort(value: unknown): value is ProviderReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.some((effort) => effort === value);
}

function cursorModelFamily(id: string): { family: string; effort?: string } {
  const match = /-(none|minimal|low|medium|high|xhigh|extra-high|max|ultra)(-fast)?$/.exec(id);
  return match
    ? {
        family: id.slice(0, match.index) + (match[2] ?? ""),
        ...(match[1] ? { effort: match[1] === "extra-high" ? "xhigh" : match[1] } : {}),
      }
    : { family: id };
}

function cursorSelection(model: string | undefined, models: AgentModel[]) {
  const selected =
    model && model !== DEFAULT_CURSOR_MODEL ? model : pickCursorNormalModelId(models);
  if (!selected || selected === "auto") return undefined;
  const bracket = /^([^[]+)\[([^\]]*)\]$/.exec(selected);
  const base = bracket?.[1] ?? selected;
  const parameters = bracket
    ? (bracket[2] ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
  let family = cursorModelFamily(base).family;
  const fast = parameters.find((part) => part.startsWith("fast="));
  if (fast === "fast=true" && !family.endsWith("-fast")) family += "-fast";
  if (fast === "fast=false" && family.endsWith("-fast")) family = family.slice(0, -5);
  const aliases = models.filter((candidate) => cursorModelFamily(candidate.id).family === family);
  return {
    bracket,
    base,
    parameters,
    aliases,
    reasoningEfforts: orderedEfforts(
      aliases.flatMap((candidate) => {
        const effort = cursorModelFamily(candidate.id).effort;
        return effort ? [effort] : [];
      }),
    ),
  };
}

async function claudeCatalog(includeCustom = false): Promise<AgentModelCatalog> {
  const models = listClaudeModels();
  try {
    const capabilities = await discoverClaudeModelCapabilities();
    const projected = models.map((model) => {
      const row = capabilities.find(
        (candidate) => candidate.value === model.id || candidate.displayName === model.label,
      );
      return {
        ...model,
        ...(row ? { reasoningEfforts: orderedEfforts(row.supportedEffortLevels) } : {}),
      };
    });
    for (const row of includeCustom ? capabilities : []) {
      for (const id of [row.value, row.resolvedModel]) {
        if (id && !projected.some((model) => model.id === id))
          projected.push({
            id,
            label: row.displayName,
            reasoningEfforts: orderedEfforts(row.supportedEffortLevels),
          });
      }
    }
    return {
      models: projected,
      defaultReasoningEfforts:
        projected.find((model) => model.id === DEFAULT_CLAUDE_MODEL)?.reasoningEfforts ?? [],
    };
  } catch {
    return {
      models,
      defaultReasoningEfforts: [],
      reasoningError: "Claude model capabilities unavailable",
    };
  }
}

export async function listAgentModelCatalog(
  agent: AgentName,
  opts?: { codexHomePath?: string },
): Promise<AgentModelCatalog> {
  switch (agent) {
    case "claude":
      return claudeCatalog();
    case "codex":
      return {
        models: opts?.codexHomePath ? await listCodexModels(opts.codexHomePath) : [],
        defaultReasoningEfforts: CODEX_COMPATIBILITY_EFFORTS,
      };
    case "cursor": {
      const models = await listCursorModels();
      return {
        models: models.map((model) => ({
          ...model,
          reasoningEfforts: cursorSelection(model.id, models)?.reasoningEfforts ?? [],
        })),
        defaultReasoningEfforts: cursorSelection(undefined, models)?.reasoningEfforts ?? [],
      };
    }
    case "opencode":
      return { models: await listOpenCodeModels(), defaultReasoningEfforts: [] };
  }
}

export async function resolveAgentReasoningEffort(
  agent: AgentName,
  model: string | undefined,
  reasoningEffort: ProviderReasoningEffort,
  opts?: { codexHomePath?: string },
): Promise<{ model?: string; reasoningEffort: ProviderReasoningEffort; variantNames?: string[] }> {
  if (!isReasoningEffort(reasoningEffort)) {
    throw new AgentReasoningEffortError(`Invalid reasoningEffort "${String(reasoningEffort)}"`);
  }
  const unsupported = () =>
    new AgentReasoningEffortError(
      `${agent} reasoningEffort "${reasoningEffort}" is not available${model ? ` for model "${model}"` : ""}`,
    );
  switch (agent) {
    case "claude": {
      const catalog = await claudeCatalog(true);
      const selected = catalog.models.find(
        (candidate) => candidate.id === (model ?? DEFAULT_CLAUDE_MODEL),
      );
      if (catalog.reasoningError || selected?.reasoningEfforts === undefined)
        throw new AgentReasoningEffortError("Claude model capabilities unavailable");
      if (!selected.reasoningEfforts.includes(reasoningEffort)) throw unsupported();
      return { ...(model ? { model } : {}), reasoningEffort };
    }
    case "codex": {
      const models = opts?.codexHomePath ? await listCodexModels(opts.codexHomePath, true) : [];
      const supported =
        models.find((candidate) => candidate.id === model)?.reasoningEfforts ??
        CODEX_COMPATIBILITY_EFFORTS;
      if (!supported.includes(reasoningEffort)) throw unsupported();
      return { ...(model ? { model } : {}), reasoningEffort };
    }
    case "cursor": {
      const models = await listCursorModels();
      const selection = cursorSelection(model, models);
      if (!selection) throw unsupported();
      const { bracket, base, parameters, aliases } = selection;
      const alias = aliases.find((candidate) => {
        const parsed = cursorModelFamily(candidate.id);
        return parsed.effort === reasoningEffort;
      });
      if (!alias) throw unsupported();
      return {
        model: bracket
          ? `${base}[${[...parameters.filter((part) => !/^effort\s*=/.test(part)), `effort=${reasoningEffort}`].join(",")}]`
          : alias.id,
        reasoningEffort,
      };
    }
    case "opencode": {
      if (!model)
        throw new AgentReasoningEffortError(
          "OpenCode reasoningEffort requires a model; select a provider/model with advertised variants",
        );
      let models: AgentModel[];
      try {
        models = await discoverOpenCodeModels();
      } catch (error) {
        const missingExecutable = missingOpenCodeExecutableError(error);
        throw new AgentReasoningEffortError(
          missingExecutable?.message ??
            "Cannot validate OpenCode reasoningEffort: model list unavailable",
          { cause: error },
        );
      }
      const selected = models.find((candidate) => candidate.id === model);
      if (!selected)
        throw new AgentReasoningEffortError(`OpenCode model "${model}" is not available`);
      if (!selected.variantNames?.includes(reasoningEffort)) throw unsupported();
      return { model, reasoningEffort, variantNames: selected.variantNames };
    }
  }
}

export async function listAgentModels(
  agent: AgentName,
  opts?: { codexHomePath?: string },
): Promise<AgentModel[]> {
  return (await listAgentModelCatalog(agent, opts)).models;
}

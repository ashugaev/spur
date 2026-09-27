import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentName,
  PreflightTokenUsageRecord,
  PreflightTokenUsageView,
  PreflightUsageProvider,
  TokenUsageTotals,
} from "./types.js";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPTIONAL_COMPONENTS = [
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
  "cacheWrite5mInputTokens",
  "cacheWrite1hInputTokens",
] as const;

export interface PreflightAttemptResult {
  usage?: TokenUsageTotals;
  providerIterationCount?: number;
}

interface AttemptRecord {
  sequence: number;
  provider: PreflightUsageProvider;
  startedAt: string;
  finishedAt?: string;
  outcome: "started" | "measured" | "unknown";
  providerIterationCount: number;
  usage?: TokenUsageTotals;
}

interface BatchRecord {
  version: 1;
  id: string;
  project: string;
  createdAt: string;
  updatedAt: string;
  claimedBy?: string;
  claimedAt?: string;
  attempts: AttemptRecord[];
  accountingIncomplete?: boolean;
}

class UnavailableBatchError extends Error {
  constructor(readonly identity?: { project?: string; claimedBy?: string }) {
    super("Preflight accounting is unavailable");
  }
}

function isProvider(value: unknown): value is PreflightUsageProvider {
  return value === "claude" || value === "codex" || value === "cursor" || value === "opencode";
}

export function normalizePreflightTotals(value: unknown): TokenUsageTotals | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inputTokens = record["inputTokens"];
  const outputTokens = record["outputTokens"];
  const totalTokens = record["totalTokens"];
  if (
    !Number.isSafeInteger(inputTokens) ||
    (inputTokens as number) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens as number) < 0 ||
    !Number.isSafeInteger(totalTokens) ||
    totalTokens !== (inputTokens as number) + (outputTokens as number)
  )
    return null;
  const totals: TokenUsageTotals = {
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    totalTokens,
  };
  for (const component of OPTIONAL_COMPONENTS) {
    const token = record[component];
    if (token === undefined) continue;
    if (!Number.isSafeInteger(token) || (token as number) < 0) return null;
    totals[component] = token as number;
  }
  if (
    (totals.cacheReadInputTokens ?? 0) + (totals.cacheWriteInputTokens ?? 0) > totals.inputTokens ||
    (totals.reasoningOutputTokens ?? 0) > totals.outputTokens ||
    (totals.cacheWrite5mInputTokens ?? 0) + (totals.cacheWrite1hInputTokens ?? 0) >
      (totals.cacheWriteInputTokens ?? 0)
  )
    return null;
  return totals;
}

function parseBatch(value: unknown): BatchRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record["version"] !== 1 ||
    typeof record["id"] !== "string" ||
    !BATCH_ID.test(record["id"]) ||
    typeof record["project"] !== "string" ||
    typeof record["createdAt"] !== "string" ||
    typeof record["updatedAt"] !== "string" ||
    !Array.isArray(record["attempts"])
  )
    return null;
  if (record["claimedBy"] !== undefined && typeof record["claimedBy"] !== "string") return null;
  const attempts: AttemptRecord[] = [];
  for (const raw of record["attempts"]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const attempt = raw as Record<string, unknown>;
    if (
      !Number.isSafeInteger(attempt["sequence"]) ||
      (attempt["sequence"] as number) < 1 ||
      !isProvider(attempt["provider"]) ||
      typeof attempt["startedAt"] !== "string" ||
      (attempt["outcome"] !== "started" &&
        attempt["outcome"] !== "measured" &&
        attempt["outcome"] !== "unknown") ||
      !Number.isSafeInteger(attempt["providerIterationCount"]) ||
      (attempt["providerIterationCount"] as number) < 1
    )
      return null;
    const usage =
      attempt["usage"] === undefined ? undefined : normalizePreflightTotals(attempt["usage"]);
    if (attempt["outcome"] === "measured" && !usage) return null;
    attempts.push({
      sequence: attempt["sequence"] as number,
      provider: attempt["provider"],
      startedAt: attempt["startedAt"],
      ...(typeof attempt["finishedAt"] === "string" ? { finishedAt: attempt["finishedAt"] } : {}),
      outcome: attempt["outcome"],
      providerIterationCount: attempt["providerIterationCount"] as number,
      ...(usage ? { usage } : {}),
    });
  }
  return {
    version: 1,
    id: record["id"],
    project: record["project"],
    createdAt: record["createdAt"],
    updatedAt: record["updatedAt"],
    ...(typeof record["claimedBy"] === "string" ? { claimedBy: record["claimedBy"] } : {}),
    ...(typeof record["claimedAt"] === "string" ? { claimedAt: record["claimedAt"] } : {}),
    attempts,
    ...(record["accountingIncomplete"] === true ? { accountingIncomplete: true } : {}),
  };
}

function batchUsage(batch: BatchRecord): PreflightTokenUsageRecord {
  const usage = aggregatePreflightAttempts(batch.attempts);
  if (batch.accountingIncomplete) {
    usage.status = batch.attempts.some((attempt) => attempt.outcome === "measured")
      ? "partial"
      : "unknown";
  }
  return usage;
}

function addTotals(values: TokenUsageTotals[]): TokenUsageTotals {
  const totals: TokenUsageTotals = {
    inputTokens: values.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: values.reduce((sum, value) => sum + value.outputTokens, 0),
    totalTokens: values.reduce((sum, value) => sum + value.totalTokens, 0),
  };
  for (const component of OPTIONAL_COMPONENTS) {
    if (values.length > 0 && values.every((value) => value[component] !== undefined)) {
      totals[component] = values.reduce((sum, value) => sum + (value[component] ?? 0), 0);
    }
  }
  return totals;
}

export function aggregatePreflightAttempts(attempts: AttemptRecord[]): PreflightTokenUsageRecord {
  const measured = attempts.filter(
    (attempt): attempt is AttemptRecord & { usage: TokenUsageTotals } =>
      attempt.outcome === "measured" && attempt.usage !== undefined,
  );
  const unknownAttemptCount = attempts.length - measured.length;
  const byProvider: PreflightTokenUsageRecord["byProvider"] = {};
  for (const provider of ["claude", "codex", "cursor", "opencode"] as const) {
    const values = measured
      .filter((attempt) => attempt.provider === provider)
      .map((attempt) => attempt.usage);
    if (values.length > 0) byProvider[provider] = addTotals(values);
  }
  return {
    status: unknownAttemptCount === 0 ? "measured" : measured.length > 0 ? "partial" : "unknown",
    attemptCount: attempts.length,
    unknownAttemptCount,
    providerIterationCount: attempts.reduce(
      (sum, attempt) => sum + attempt.providerIterationCount,
      0,
    ),
    byProvider,
    ...addTotals(measured.map((attempt) => attempt.usage)),
  };
}

export function preflightUsageView(record: PreflightTokenUsageRecord): PreflightTokenUsageView {
  if (record.status === "unknown") {
    return {
      status: "unknown",
      attemptCount: record.attemptCount,
      unknownAttemptCount: record.unknownAttemptCount,
      providerIterationCount: record.providerIterationCount,
    };
  }
  return record;
}

export class PreflightUsageStore {
  private readonly directory: string;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly createdIds = new Set<string>();
  private readonly memory = new Map<string, BatchRecord>();
  private collisionSequence = 0;

  constructor(dataDir: string) {
    this.directory = join(dataDir, "preflight-batches");
  }

  private path(id: string): string {
    if (!BATCH_ID.test(id)) throw new Error("invalid preflightBatchId");
    return join(this.directory, `${id}.json`);
  }

  private async write(batch: BatchRecord): Promise<void> {
    const path = this.path(batch.id);
    this.memory.set(batch.id, structuredClone(batch));
    try {
      await mkdir(this.directory, { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
      await rename(temp, path);
    } catch {
      // Accounting persistence must not repeat or prevent the provider call.
    }
  }

  private async read(id: string): Promise<BatchRecord> {
    const path = this.path(id);
    const cached = this.memory.get(id);
    if (cached) return structuredClone(cached);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`Unknown preflight batch ${id}`, { cause: error });
      }
      throw new UnavailableBatchError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new UnavailableBatchError();
    }
    const batch = parseBatch(parsed);
    if (!batch) {
      const identity =
        parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      throw new UnavailableBatchError({
        ...(typeof identity["project"] === "string" ? { project: identity["project"] } : {}),
        ...(typeof identity["claimedBy"] === "string" ? { claimedBy: identity["claimedBy"] } : {}),
      });
    }
    if (batch.id !== id) throw new Error("preflight batch identity mismatch");
    const now = new Date().toISOString();
    let recovered = false;
    for (const attempt of batch.attempts) {
      if (attempt.outcome !== "started") continue;
      attempt.outcome = "unknown";
      attempt.finishedAt = now;
      recovered = true;
    }
    if (recovered) {
      batch.updatedAt = now;
      await this.write(batch);
    }
    this.memory.set(id, structuredClone(batch));
    return batch;
  }

  private async withBatchLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve();
    let release: () => void = () => {};
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prior.then(() => turn);
    this.chains.set(id, chain);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.chains.get(id) === chain) this.chains.delete(id);
    }
  }

  async create(project: string, accountingIncomplete = false): Promise<string> {
    const base = randomUUID();
    let id: string = base;
    while (this.createdIds.has(id)) {
      this.collisionSequence += 1;
      const suffix = (BigInt(`0x${base.slice(-12)}`) ^ BigInt(this.collisionSequence))
        .toString(16)
        .padStart(12, "0");
      id = `${base.slice(0, -12)}${suffix}`;
    }
    this.createdIds.add(id);
    const now = new Date().toISOString();
    try {
      await this.write({
        version: 1,
        id,
        project,
        createdAt: now,
        updatedAt: now,
        attempts: [],
        ...(accountingIncomplete ? { accountingIncomplete: true } : {}),
      });
    } catch (error) {
      this.createdIds.delete(id);
      throw error;
    }
    return id;
  }

  async resolve(project: string, requested?: string): Promise<string> {
    if (!requested) return this.create(project);
    this.path(requested);
    return this.withBatchLock(requested, async () => {
      let batch: BatchRecord;
      try {
        batch = await this.read(requested);
      } catch (error) {
        if (error instanceof UnavailableBatchError) {
          if (error.identity?.project !== undefined && error.identity.project !== project) {
            throw new Error("preflight batch project mismatch", { cause: error });
          }
          if (error.identity?.claimedBy)
            throw new Error("preflight batch is already claimed", { cause: error });
          return this.create(project, true);
        }
        if (!(error instanceof Error) || !error.message.startsWith("Unknown preflight batch")) {
          throw error;
        }
        const now = new Date().toISOString();
        batch = {
          version: 1,
          id: requested,
          project,
          createdAt: now,
          updatedAt: now,
          attempts: [],
        };
        await this.write(batch);
      }
      if (batch.project !== project) throw new Error("preflight batch project mismatch");
      return requested;
    });
  }

  async runAttempt<T extends PreflightAttemptResult>(
    id: string,
    project: string,
    provider: AgentName,
    execute: () => Promise<T>,
    claimedBy?: string,
  ): Promise<T> {
    return this.withBatchLock(id, async () => {
      const batch = await this.read(id);
      if (batch.project !== project) throw new Error("preflight batch project mismatch");
      if (batch.claimedBy && batch.claimedBy !== claimedBy) {
        throw new Error("preflight batch is already claimed");
      }
      const now = new Date().toISOString();
      const attempt: AttemptRecord = {
        sequence: batch.attempts.length + 1,
        provider,
        startedAt: now,
        outcome: "started",
        providerIterationCount: 1,
      };
      batch.attempts.push(attempt);
      batch.updatedAt = now;
      await this.write(batch);
      try {
        const result = await execute();
        const usage = result.usage ? normalizePreflightTotals(result.usage) : null;
        attempt.outcome = usage ? "measured" : "unknown";
        if (usage) attempt.usage = usage;
        attempt.providerIterationCount = result.providerIterationCount ?? 1;
        attempt.finishedAt = new Date().toISOString();
        batch.updatedAt = attempt.finishedAt;
        await this.write(batch);
        return result;
      } catch (error) {
        const usage =
          error && typeof error === "object" && "usage" in error
            ? normalizePreflightTotals((error as { usage?: unknown }).usage)
            : null;
        attempt.outcome = usage ? "measured" : "unknown";
        if (usage) attempt.usage = usage;
        attempt.finishedAt = new Date().toISOString();
        batch.updatedAt = attempt.finishedAt;
        await this.write(batch);
        throw error;
      }
    });
  }

  async view(id: string, project: string): Promise<PreflightTokenUsageView> {
    return this.withBatchLock(id, async () => {
      const batch = await this.read(id);
      if (batch.project !== project) throw new Error("preflight batch project mismatch");
      return preflightUsageView(batchUsage(batch));
    });
  }

  async claim(id: string, project: string, sessionId: string): Promise<PreflightTokenUsageRecord> {
    return this.withBatchLock(id, async () => {
      const batch = await this.read(id);
      if (batch.project !== project) throw new Error("preflight batch project mismatch");
      if (batch.claimedBy && batch.claimedBy !== sessionId) {
        throw new Error("preflight batch was claimed by another session");
      }
      if (!batch.claimedBy) {
        batch.claimedBy = sessionId;
        batch.claimedAt = new Date().toISOString();
        batch.updatedAt = batch.claimedAt;
        await this.write(batch);
      }
      return batchUsage(batch);
    });
  }

  async prune(now = Date.now()): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const id = name.slice(0, -5);
          try {
            await this.withBatchLock(id, async () => {
              const batch = await this.read(id);
              if (
                batch.attempts.every((attempt) => attempt.outcome !== "started") &&
                now - Date.parse(batch.updatedAt) > RETENTION_MS
              ) {
                await rm(this.path(id), { force: true });
                this.memory.delete(id);
              }
            });
          } catch {
            // Corrupt records stay for operator inspection.
          }
        }),
    );
  }
}

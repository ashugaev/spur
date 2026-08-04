import { gh, pollBudgetState, recordGraphqlBudget } from "./gh.js";
import type { PrLookupTerminalPr, PrRepoSlug } from "./pr-lookup-cache.js";
import { readRemoteUrl } from "./workspace.js";

// Batched PR discovery.
//
// One `gh api graphql` per repo per flush, many branches per query, instead of
// one `gh pr list --head` per branch per sweep. The measured GraphQL cost of a
// 50-alias `first:5` query is 1 point — the same as a single `gh pr list` — and
// the response carries the `rateLimit` block, so the shared budget is learned
// for free. Auth stays inside `gh`: no GITHUB_TOKEN handling here, and gh stays
// the process's sole spawner so invocation accounting keeps covering everything.

// 50 aliases build a ~7 KB query string: 5% of the 131072-byte single-argv
// ceiling (MAX_ARG_STRLEN) and 0.3% of ARG_MAX, so argv cannot approach E2BIG
// even with long branch names.
const PR_LOOKUP_BATCH_SIZE = 50;
// A worktree's remote is re-read at most this often. A remote rewrite is picked
// up on the next expiry.
const REPO_SLUG_MEMO_TTL_MS = 30 * 60_000;
// Newest PRs per branch. A branch whose newest PRs are all merged/closed is
// classified terminal instead of climbing the miss backoff.
const PR_LOOKUP_PRS_PER_BRANCH = 5;

export interface PrLookupRequest {
  slug: PrRepoSlug;
  branch: string;
  /** Any worktree of the repo; used only as gh's cwd for auth resolution. */
  worktreePath: string;
}

export interface PrLookupPr {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
}

export type PrLookupSkipReason = "budget" | "repo_unresolved" | "error" | "cancelled";

/**
 * A skipped outcome is not an answer: callers must never record it as "no PR".
 * A false negative written during a rate-limit window outlives the window.
 */
export type PrLookupOutcome =
  | { status: "found"; pr: PrLookupPr }
  | { status: "absent" }
  | { status: "terminal"; pr: PrLookupTerminalPr }
  | { status: "skipped"; reason: PrLookupSkipReason; message?: string };

interface SlugMemoEntry {
  slug: PrRepoSlug | null;
  readAt: number;
}

interface PendingRequest {
  request: PrLookupRequest;
  settle: (outcome: PrLookupOutcome) => void;
}

const slugMemo = new Map<string, SlugMemoEntry>();
// Fork redirects: a repo whose PRs live on its upstream parent. Learned from
// the `isFork`/`parent` fields that ride inside the batch response, so no extra
// query is spent discovering it.
const baseRepoRedirects = new Map<string, PrRepoSlug>();
const pending = new Map<string, PendingRequest[]>();

export function _resetPrLookupsForTests(): void {
  slugMemo.clear();
  baseRepoRedirects.clear();
  pending.clear();
}

function slugKey(slug: PrRepoSlug): string {
  return `${slug.owner}/${slug.name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseRepoSlugFromRemoteUrl(url: string): PrRepoSlug | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  const match =
    /^(?:https?:\/\/|git:\/\/|ssh:\/\/)?(?:[^@/]+@)?[^/:]*github\.com[/:]([^/]+)\/([^/]+)$/.exec(
      trimmed,
    );
  const owner = match?.[1];
  const name = match?.[2];
  if (!owner || !name) {
    return null;
  }
  return { owner, name };
}

/**
 * Repo slug for a worktree, from the `upstream` remote when present, else
 * `origin`. Memoized per worktree: git spawns, never GitHub budget.
 */
export async function resolvePrLookupRepo(
  worktreePath: string,
  nowMs: number = Date.now(),
): Promise<PrRepoSlug | null> {
  const memo = slugMemo.get(worktreePath);
  if (memo && nowMs - memo.readAt < REPO_SLUG_MEMO_TTL_MS) {
    return memo.slug === null ? null : (baseRepoRedirects.get(slugKey(memo.slug)) ?? memo.slug);
  }
  let slug: PrRepoSlug | null = null;
  for (const remote of ["upstream", "origin"]) {
    const url = await readRemoteUrl(worktreePath, remote);
    slug = url ? parseRepoSlugFromRemoteUrl(url) : null;
    if (slug) {
      break;
    }
  }
  slugMemo.set(worktreePath, { slug, readAt: nowMs });
  if (!slug) {
    return null;
  }
  return baseRepoRedirects.get(slugKey(slug)) ?? slug;
}

export function buildAliasedBranchQuery(branches: string[]): {
  query: string;
  aliases: Array<{ alias: string; branch: string }>;
} {
  const aliases = branches.map((branch, index) => ({ alias: `a${index}`, branch }));
  const varDecls = ["$owner:String!", "$name:String!"];
  const fields: string[] = [];
  for (const [index, entry] of aliases.entries()) {
    const branchVar = `b${index}`;
    varDecls.push(`$${branchVar}:String!`);
    fields.push(
      `${entry.alias}: pullRequests(headRefName:$${branchVar},first:${PR_LOOKUP_PRS_PER_BRANCH},orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title url state}}`,
    );
  }
  const query = `query(${varDecls.join(",")}){rateLimit{limit cost remaining resetAt} r: repository(owner:$owner,name:$name){nameWithOwner isFork parent{nameWithOwner} ${fields.join(" ")}}}`;
  return { query, aliases };
}

/**
 * Maps each GraphQL error to the alias it belongs to via its `path`. The branch
 * aliases are nested under the `r` repository field, so any path segment may
 * carry the alias. An error with no resolvable alias is dropped rather than
 * smeared over every branch in the chunk.
 */
export function gqlErrorsByAlias(errorsRaw: unknown, aliases: Set<string>): Map<string, string> {
  const byAlias = new Map<string, string>();
  if (!Array.isArray(errorsRaw)) {
    return byAlias;
  }
  for (const entry of errorsRaw) {
    if (!isRecord(entry)) {
      continue;
    }
    const message = typeof entry["message"] === "string" ? entry["message"].trim() : "";
    if (!message) {
      continue;
    }
    const path = entry["path"];
    if (!Array.isArray(path)) {
      continue;
    }
    const alias = path.find(
      (segment): segment is string => typeof segment === "string" && aliases.has(segment),
    );
    if (!alias) {
      continue;
    }
    const existing = byAlias.get(alias);
    byAlias.set(alias, existing ? `${existing}; ${message}` : message);
  }
  return byAlias;
}

function readEnvelopeFromError(error: unknown): unknown {
  // gh exits nonzero when a GraphQL response carries an `errors` array, but it
  // still prints the whole envelope — including the resolved aliases — on
  // stdout. Recover it so one bad alias does not discard its siblings.
  if (!isRecord(error) || typeof error["stdout"] !== "string") {
    return null;
  }
  try {
    return JSON.parse(error["stdout"]) as unknown;
  } catch {
    return null;
  }
}

function parsePrNode(value: unknown): PrLookupPr | null {
  if (!isRecord(value)) {
    return null;
  }
  const number = value["number"];
  const title = value["title"];
  const url = value["url"];
  const state = value["state"];
  if (typeof number !== "number" || typeof url !== "string") {
    return null;
  }
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
    return null;
  }
  return { number, title: typeof title === "string" ? title : "", url, state };
}

function outcomeForNodes(nodesRaw: unknown): PrLookupOutcome {
  if (!Array.isArray(nodesRaw)) {
    return { status: "skipped", reason: "error", message: "malformed pullRequests payload" };
  }
  const nodes = nodesRaw.map(parsePrNode).filter((node): node is PrLookupPr => node !== null);
  const open = nodes.find((node) => node.state === "OPEN");
  if (open) {
    return { status: "found", pr: open };
  }
  const newest = nodes[0];
  if (newest && newest.state !== "OPEN") {
    return { status: "terminal", pr: { number: newest.number, state: newest.state } };
  }
  return { status: "absent" };
}

function recordBudgetFromEnvelope(data: Record<string, unknown>, nowMs: number): void {
  const rateLimit = data["rateLimit"];
  if (!isRecord(rateLimit) || typeof rateLimit["remaining"] !== "number") {
    return;
  }
  const resetAt = rateLimit["resetAt"];
  const resetAtMs = typeof resetAt === "string" ? Date.parse(resetAt) : Number.NaN;
  recordGraphqlBudget(rateLimit["remaining"], Number.isFinite(resetAtMs) ? resetAtMs : null, nowMs);
}

/**
 * Learns a fork's upstream parent from the repository block already in the
 * response, so the next flush queries the repo that actually owns the PRs. The
 * current chunk is skipped rather than answered: a fork's own `pullRequests`
 * connection is empty, and recording that as "no PR" would be a false negative.
 */
function adoptBaseRepo(slug: PrRepoSlug, repo: Record<string, unknown>): PrRepoSlug | null {
  if (repo["isFork"] !== true) {
    return null;
  }
  const parent = repo["parent"];
  if (!isRecord(parent) || typeof parent["nameWithOwner"] !== "string") {
    return null;
  }
  const [owner, name] = parent["nameWithOwner"].split("/");
  if (!owner || !name) {
    return null;
  }
  const parentSlug: PrRepoSlug = { owner, name };
  if (slugKey(parentSlug) === slugKey(slug)) {
    return null;
  }
  baseRepoRedirects.set(slugKey(slug), parentSlug);
  return parentSlug;
}

async function runChunk(
  slug: PrRepoSlug,
  cwd: string,
  branches: string[],
): Promise<Map<string, PrLookupOutcome>> {
  const results = new Map<string, PrLookupOutcome>();
  const { query, aliases } = buildAliasedBranchQuery(branches);
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${slug.owner}`,
    "-f",
    `name=${slug.name}`,
  ];
  for (const [index, entry] of aliases.entries()) {
    args.push("-f", `b${index}=${entry.branch}`);
  }

  let envelope: unknown;
  let failure: string | null = null;
  try {
    envelope = JSON.parse(await gh(cwd, ...args)) as unknown;
  } catch (error) {
    envelope = readEnvelopeFromError(error);
    failure = error instanceof Error ? error.message : String(error);
  }

  const data = isRecord(envelope) && isRecord(envelope["data"]) ? envelope["data"] : null;
  if (!data) {
    for (const entry of aliases) {
      results.set(entry.branch, {
        status: "skipped",
        reason: "error",
        message: failure ?? "malformed graphql response",
      });
    }
    return results;
  }
  recordBudgetFromEnvelope(data, Date.now());

  const repo = data["r"];
  if (!isRecord(repo)) {
    for (const entry of aliases) {
      results.set(entry.branch, {
        status: "skipped",
        reason: "repo_unresolved",
        message: failure ?? `repository ${slugKey(slug)} not resolvable`,
      });
    }
    return results;
  }
  const parentSlug = adoptBaseRepo(slug, repo);
  if (parentSlug) {
    for (const entry of aliases) {
      results.set(entry.branch, {
        status: "skipped",
        reason: "repo_unresolved",
        message: `${slugKey(slug)} is a fork; retrying against ${slugKey(parentSlug)}`,
      });
    }
    return results;
  }

  const errorsByAlias = gqlErrorsByAlias(
    isRecord(envelope) ? envelope["errors"] : null,
    new Set(aliases.map((entry) => entry.alias)),
  );
  for (const entry of aliases) {
    const message = errorsByAlias.get(entry.alias);
    if (message) {
      results.set(entry.branch, { status: "skipped", reason: "error", message });
      continue;
    }
    const field = repo[entry.alias];
    if (!isRecord(field)) {
      results.set(entry.branch, {
        status: "skipped",
        reason: "error",
        message: failure ?? `missing alias ${entry.alias}`,
      });
      continue;
    }
    results.set(entry.branch, outcomeForNodes(field["nodes"]));
  }
  return results;
}

function chunked<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/**
 * Resolves lookups now, one gh call per repo per chunk of 50 branches. The
 * budget ledger is deliberately NOT consulted here: this is the interactive
 * entry point (teardown's open-PR check), which keeps today's behavior. Only
 * the queued poll path defers to the ledger.
 */
export async function resolvePrLookups(requests: PrLookupRequest[]): Promise<PrLookupOutcome[]> {
  return resolveLookups(requests, false);
}

async function resolveLookups(
  requests: PrLookupRequest[],
  respectBudget: boolean,
): Promise<PrLookupOutcome[]> {
  const outcomes = new Array<PrLookupOutcome>(requests.length);
  const byRepo = new Map<string, { slug: PrRepoSlug; cwd: string; indices: number[] }>();
  for (const [index, request] of requests.entries()) {
    const key = slugKey(request.slug);
    const group = byRepo.get(key);
    if (group) {
      group.indices.push(index);
      continue;
    }
    byRepo.set(key, { slug: request.slug, cwd: request.worktreePath, indices: [index] });
  }

  for (const group of byRepo.values()) {
    const branches = [...new Set(group.indices.map((index) => requests[index]?.branch ?? ""))];
    for (const chunk of chunked(branches, PR_LOOKUP_BATCH_SIZE)) {
      const budget = respectBudget ? pollBudgetState() : ({ blocked: false } as const);
      const chunkBranches = new Set(chunk);
      const results = budget.blocked
        ? new Map<string, PrLookupOutcome>(
            chunk.map((branch) => [
              branch,
              {
                status: "skipped",
                reason: "budget",
                message: `graphql budget paused (${budget.reason}${budget.resetAt ? `, resets ${budget.resetAt}` : ""})`,
              } satisfies PrLookupOutcome,
            ]),
          )
        : await runChunk(group.slug, group.cwd, chunk);
      for (const index of group.indices) {
        const request = requests[index];
        if (!request || !chunkBranches.has(request.branch)) {
          continue;
        }
        outcomes[index] = results.get(request.branch) ?? {
          status: "skipped",
          reason: "error",
          message: "no result for branch",
        };
      }
    }
  }

  // Every index belongs to exactly one repo group and its branch to exactly one
  // chunk of that group, so the array is fully populated here.
  return outcomes;
}

/**
 * Queues a lookup to ride the next flush. A repo whose pending set fills a
 * whole chunk flushes immediately; everything else is flushed by the caller at
 * the end of its sweep, which is the natural batch window.
 */
export function enqueuePrLookup(request: PrLookupRequest): Promise<PrLookupOutcome> {
  const key = slugKey(request.slug);
  const queue = pending.get(key) ?? [];
  if (!pending.has(key)) {
    pending.set(key, queue);
  }
  return new Promise<PrLookupOutcome>((resolve) => {
    queue.push({ request, settle: resolve });
    if (queue.length >= PR_LOOKUP_BATCH_SIZE) {
      void flushRepo(key);
    }
  });
}

async function flushRepo(key: string): Promise<void> {
  const queue = pending.get(key);
  if (!queue || queue.length === 0) {
    return;
  }
  pending.delete(key);
  const outcomes = await resolveLookups(
    queue.map((entry) => entry.request),
    true,
  );
  for (const [index, entry] of queue.entries()) {
    entry.settle(
      outcomes[index] ?? { status: "skipped", reason: "error", message: "no lookup outcome" },
    );
  }
}

export async function flushPrLookups(): Promise<void> {
  await Promise.all([...pending.keys()].map((key) => flushRepo(key)));
}

/**
 * Resolves everything pending as `skipped:cancelled` so a teardown drain cannot
 * hang on a lookup that will never flush.
 */
export function cancelPendingPrLookups(): void {
  for (const queue of pending.values()) {
    for (const entry of queue) {
      entry.settle({ status: "skipped", reason: "cancelled" });
    }
  }
  pending.clear();
}

import { existsSync } from "node:fs";
import {
  gh,
  recordGraphqlBudgetFromEnvelope,
  withGhPollBudget,
  type GhPollBudgetState,
} from "./gh.js";
import {
  clearPrLookupEntry,
  isPrLookupDue,
  markPrLookupMiss,
  markPrLookupTerminal,
  readPrLookupEntry,
  type PrLookupTerminalPr,
  type PrRepoSlug,
} from "./pr-lookup-cache.js";
import { readRemoteUrls } from "./workspace.js";

// Batched PR discovery.
//
// One `gh api graphql` per repo per flush, many branches per query, instead of
// one `gh pr list --head` per branch per sweep. A 50-alias `first:5` query asks
// for 250 nodes, which GitHub bills as 3 points of the 5000/hr GraphQL budget
// (nodes/100, rounded up, summed across connections) — the response's
// `rateLimit` block carries the measured `cost`, so nothing here has to assert
// it. The same block teaches the shared budget ledger for free. Auth stays
// inside `gh`; the parsed remote hostname selects the matching gh host. gh
// stays the process's sole spawner so invocation accounting covers every call.

// 50 aliases build a ~7 KB query string: 5% of the 131072-byte single-argv
// ceiling (MAX_ARG_STRLEN) and 0.3% of ARG_MAX, so argv cannot approach E2BIG
// even with long branch names.
const PR_LOOKUP_BATCH_SIZE = 50;
// A worktree's remote is re-read at most this often. A remote rewrite is picked
// up on the next expiry.
const REPO_SLUG_MEMO_TTL_MS = 30 * 60_000;
// A remote read that resolved nothing is not an answer: it is also what one
// transient git failure looks like. Memoize a miss for seconds, never for the
// full TTL — the same memo backs teardown's open-PR check, and blackholing it
// for half an hour would hide an open PR from the user prompt.
const REPO_SLUG_MISS_MEMO_TTL_MS = 15_000;
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
const pending = new Map<string, PendingRequest[]>();
const activeFlushes = new Set<Promise<void>>();
const activePollLookups = new Map<string, Promise<PrLookupOutcome>>();

export function _resetPrLookupsForTests(): void {
  slugMemo.clear();
  pending.clear();
  activeFlushes.clear();
  activePollLookups.clear();
}

export type PollPrLookupClaim =
  | { status: "cached"; outcome: Extract<PrLookupOutcome, { status: "absent" | "terminal" }> }
  | { status: "joined"; outcome: Promise<PrLookupOutcome> }
  | { status: "owner"; settle: (outcome: PrLookupOutcome) => void };

/**
 * Claims one poll lookup across every daemon poller. Due state, query ownership,
 * and cache mutation live in this boundary so two concurrent cycles cannot both
 * query or advance the same repo/branch miss.
 */
export function claimPollPrLookup(input: {
  dataDir: string;
  slug: PrRepoSlug;
  branch: string;
  capMs: number;
  nowMs?: number;
}): PollPrLookupClaim {
  const key = JSON.stringify([
    input.dataDir,
    input.slug.host,
    input.slug.owner,
    input.slug.name,
    input.branch,
  ]);
  const active = activePollLookups.get(key);
  if (active) return { status: "joined", outcome: active };

  const nowMs = input.nowMs ?? Date.now();
  const entry = readPrLookupEntry(input.dataDir, input.slug, input.branch, nowMs);
  if (!isPrLookupDue(entry, input.capMs, nowMs)) {
    return {
      status: "cached",
      outcome: entry?.terminal ? { status: "terminal", pr: entry.terminal } : { status: "absent" },
    };
  }

  let resolveOutcome = (_outcome: PrLookupOutcome): void => {};
  const outcome = new Promise<PrLookupOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  activePollLookups.set(key, outcome);
  let settled = false;
  return {
    status: "owner",
    settle: (next) => {
      if (settled) return;
      settled = true;
      switch (next.status) {
        case "found":
          clearPrLookupEntry(input.dataDir, input.slug, input.branch);
          break;
        case "absent":
          markPrLookupMiss(input.dataDir, input.slug, input.branch);
          break;
        case "terminal":
          markPrLookupTerminal(input.dataDir, input.slug, input.branch, next.pr);
          break;
        case "skipped":
          break;
      }
      activePollLookups.delete(key);
      resolveOutcome(next);
    },
  };
}

function slugKey(slug: PrRepoSlug): string {
  return `${slug.host}/${slug.owner}/${slug.name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseRepoSlugFromRemoteUrl(url: string): PrRepoSlug | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  // Both remote shapes: scp-like `git@host:owner/repo` and
  // `scheme://[user@]host[:port]/owner/repo`.
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:](.+)$/i.exec(trimmed);
  const host = match?.[1];
  const path = match?.[2];
  if (
    !host ||
    !path ||
    host
      .toLowerCase()
      .split(".")
      .some((label) => label === "gitlab" || label === "bitbucket")
  ) {
    return null;
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) {
    return null;
  }
  const [owner, name] = segments;
  if (!owner || !name) {
    return null;
  }
  return { host: host.toLowerCase(), owner, name };
}

export interface ResolvePrLookupRepoOptions {
  nowMs?: number;
  /**
   * Ignore a memoized miss and re-read the remotes. Interactive callers pass
   * this so a transient git failure recorded by a sweep cannot answer "no
   * repo" for them.
   */
  bypassMissMemo?: boolean;
}

/**
 * Repo slug for a worktree, from the `upstream` remote when present, else
 * `origin`. One git spawn, never any GitHub budget, memoized per worktree.
 */
export async function resolvePrLookupRepo(
  worktreePath: string,
  options: ResolvePrLookupRepoOptions = {},
): Promise<PrRepoSlug | null> {
  const nowMs = options.nowMs ?? Date.now();
  const memo = slugMemo.get(worktreePath);
  if (memo) {
    const ttlMs = memo.slug ? REPO_SLUG_MEMO_TTL_MS : REPO_SLUG_MISS_MEMO_TTL_MS;
    const usable = memo.slug !== null || options.bypassMissMemo !== true;
    if (usable && nowMs - memo.readAt < ttlMs) {
      return memo.slug;
    }
  }
  const remotes = await readRemoteUrls(worktreePath);
  let slug: PrRepoSlug | null = null;
  for (const remote of ["upstream", "origin"]) {
    const url = remotes.get(remote);
    slug = url ? parseRepoSlugFromRemoteUrl(url) : null;
    if (slug) {
      break;
    }
  }
  slugMemo.set(worktreePath, { slug, readAt: nowMs });
  return slug;
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
  const query = `query(${varDecls.join(",")}){rateLimit{cost remaining resetAt} r: repository(owner:$owner,name:$name){isFork parent{nameWithOwner} ${fields.join(" ")}}}`;
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
  if (nodes.length !== nodesRaw.length) {
    // Some node came back unreadable (a null entry whose per-alias error had no
    // usable path, say). The branch's state is unknown, not "no PR".
    return { status: "skipped", reason: "error", message: "unreadable pullRequests node" };
  }
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

/**
 * The fork's upstream parent, read from the repository block already in the
 * response, or null when the response names no usable one.
 */
function forkParentOf(slug: PrRepoSlug, repo: Record<string, unknown>): PrRepoSlug | null {
  const parent = repo["parent"];
  if (!isRecord(parent) || typeof parent["nameWithOwner"] !== "string") {
    return null;
  }
  const [owner, name] = parent["nameWithOwner"].split("/");
  if (!owner || !name) {
    return null;
  }
  const parentSlug: PrRepoSlug = { host: slug.host, owner, name };
  if (slugKey(parentSlug) === slugKey(slug)) {
    return null;
  }
  return parentSlug;
}

interface ChunkAttempt {
  results: Map<string, PrLookupOutcome>;
  forkParent: PrRepoSlug | null;
}

async function runChunkOnce(
  slug: PrRepoSlug,
  cwd: string,
  branches: string[],
): Promise<ChunkAttempt> {
  const results = new Map<string, PrLookupOutcome>();
  const { query, aliases } = buildAliasedBranchQuery(branches);
  const args = [
    "api",
    "--hostname",
    slug.host,
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
  const requestedAtMs = Date.now();
  try {
    envelope = JSON.parse(await gh(cwd, ...args)) as unknown;
  } catch (error) {
    envelope = readEnvelopeFromError(error);
    failure = error instanceof Error ? error.message : String(error);
  }
  recordGraphqlBudgetFromEnvelope(envelope, requestedAtMs);

  const data = isRecord(envelope) && isRecord(envelope["data"]) ? envelope["data"] : null;
  if (!data) {
    for (const entry of aliases) {
      results.set(entry.branch, {
        status: "skipped",
        reason: "error",
        message: failure ?? "malformed graphql response",
      });
    }
    return { results, forkParent: null };
  }
  const repo = data["r"];
  if (!isRecord(repo)) {
    for (const entry of aliases) {
      results.set(entry.branch, {
        status: "skipped",
        reason: "repo_unresolved",
        message: failure ?? `repository ${slugKey(slug)} not resolvable`,
      });
    }
    return { results, forkParent: null };
  }
  if (repo["isFork"] === true) {
    // A fork's own `pullRequests` connection does not contain the PRs it opened
    // against its parent, so its answer would be a false negative. Never absent
    // from here — with a parent named, the caller asks the parent instead.
    const forkParent = forkParentOf(slug, repo);
    for (const entry of aliases) {
      results.set(entry.branch, {
        status: "skipped",
        reason: "repo_unresolved",
        message: forkParent
          ? `${slugKey(slug)} is a fork of ${slugKey(forkParent)}`
          : `${slugKey(slug)} is a fork with no resolvable parent`,
      });
    }
    return { results, forkParent };
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
  return { results, forkParent: null };
}

async function runChunk(
  slug: PrRepoSlug,
  cwd: string,
  branches: string[],
  mode: "interactive" | "poll",
): Promise<Map<string, PrLookupOutcome>> {
  const first = await runChunkOnceWithAdmission(slug, cwd, branches, mode);
  if (first.status === "blocked") {
    return budgetSkippedOutcomes(branches, first.budget);
  }
  const attempt = first.value;
  if (!attempt.forkParent) {
    return attempt.results;
  }
  // The PRs live on the parent. Ask it right away instead of burning the chunk:
  // a fork-of-a-fork still comes back repo_unresolved, never absent.
  const parent = await runChunkOnceWithAdmission(attempt.forkParent, cwd, branches, mode);
  return parent.status === "blocked"
    ? budgetSkippedOutcomes(branches, parent.budget)
    : parent.value.results;
}

type BlockedBudget = Extract<GhPollBudgetState, { blocked: true }>;

async function runChunkOnceWithAdmission(
  slug: PrRepoSlug,
  cwd: string,
  branches: string[],
  mode: "interactive" | "poll",
): Promise<
  { status: "completed"; value: ChunkAttempt } | { status: "blocked"; budget: BlockedBudget }
> {
  if (mode === "interactive") {
    return { status: "completed", value: await runChunkOnce(slug, cwd, branches) };
  }
  const admission = await withGhPollBudget(() => runChunkOnce(slug, cwd, branches));
  return admission.status === "blocked"
    ? { status: "blocked", budget: admission.budget }
    : { status: "completed", value: admission.value };
}

function budgetSkippedOutcomes(
  branches: string[],
  budget: BlockedBudget,
): Map<string, PrLookupOutcome> {
  return new Map(
    branches.map((branch) => [
      branch,
      {
        status: "skipped",
        reason: "budget",
        message: `graphql budget paused (${budget.reason}${budget.resetAt ? `, resets ${budget.resetAt}` : ""})`,
      } satisfies PrLookupOutcome,
    ]),
  );
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
 * budget ledger is deliberately NOT consulted on the interactive path (the
 * teardown open-PR check), which keeps today's behavior. Only the queued poll
 * path defers to the ledger.
 */
export async function resolvePrLookups(requests: PrLookupRequest[]): Promise<PrLookupOutcome[]> {
  return resolveLookups(requests, "interactive");
}

interface RepoGroup {
  slug: PrRepoSlug;
  /** Every requester's worktree, in request order; gh needs one that exists. */
  cwds: string[];
  indices: number[];
}

async function resolveLookups(
  requests: PrLookupRequest[],
  mode: "interactive" | "poll",
): Promise<PrLookupOutcome[]> {
  const outcomes = new Array<PrLookupOutcome>(requests.length);
  const byRepo = new Map<string, RepoGroup>();
  for (const [index, request] of requests.entries()) {
    const key = slugKey(request.slug);
    const group = byRepo.get(key);
    if (group) {
      group.indices.push(index);
      if (!group.cwds.includes(request.worktreePath)) {
        group.cwds.push(request.worktreePath);
      }
      continue;
    }
    byRepo.set(key, { slug: request.slug, cwds: [request.worktreePath], indices: [index] });
  }

  for (const group of byRepo.values()) {
    const branches = [...new Set(group.indices.map((index) => requests[index]?.branch ?? ""))];
    for (const chunk of chunked(branches, PR_LOOKUP_BATCH_SIZE)) {
      const chunkBranches = new Set(chunk);
      const results = await runChunk(group.slug, pickGroupCwd(group), chunk, mode);
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
 * gh's cwd for a repo's batch. Any worktree of the repo will do, but it has to
 * still be there at flush time: a worktree removed between enqueue and flush
 * makes gh refuse the call and would skip the whole repo for the sweep.
 */
function pickGroupCwd(group: RepoGroup): string {
  const first = group.cwds[0] ?? "";
  for (const cwd of group.cwds) {
    if (existsSync(cwd)) {
      return cwd;
    }
  }
  return first;
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
      startFlushRepo(key);
    }
  });
}

function startFlushRepo(key: string): void {
  const flush = flushRepo(key);
  activeFlushes.add(flush);
  void flush.finally(() => activeFlushes.delete(flush));
}

/**
 * Flushes one repo's queue. Never rejects and never leaves an entry unsettled:
 * every awaiting `runPrCheck` must complete or the daemon's teardown drain
 * hangs on it, and a floating rejection would take the process down.
 */
async function flushRepo(key: string): Promise<void> {
  const queue = pending.get(key);
  if (!queue || queue.length === 0) {
    return;
  }
  pending.delete(key);
  try {
    const outcomes = await resolveLookups(
      queue.map((entry) => entry.request),
      "poll",
    );
    for (const [index, entry] of queue.entries()) {
      entry.settle(
        outcomes[index] ?? { status: "skipped", reason: "error", message: "no lookup outcome" },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const entry of queue) {
      entry.settle({ status: "skipped", reason: "error", message });
    }
  }
}

export async function flushPrLookups(): Promise<void> {
  for (const key of [...pending.keys()]) {
    startFlushRepo(key);
  }
  while (activeFlushes.size > 0) {
    await Promise.all([...activeFlushes]);
  }
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

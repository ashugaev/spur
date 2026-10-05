import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import {
  GitHubApp,
  ReviewAppError,
  integer,
  object,
  readJson,
  string,
  type AppCredentials,
} from "./github-app.js";

type Lane = "code" | "browser";
interface Config {
  repositories: string[];
  receiptRoot: string;
  code: AppCredentials;
  browser: AppCredentials;
}
interface Row {
  status: "passed" | "failed";
  evidence: string;
}
interface Attempt {
  repo: string;
  pr: number;
  lane: Lane;
  session: string;
  attempt: string;
  H: string;
  B: string;
  contractDigest: string;
  receipt: string;
}
interface Request extends Attempt {
  body: string;
  verdict: "APPROVED" | "CHANGES_REQUESTED";
  coverage: { challenger: string; output: string; omissionsClosed: boolean };
  rows: Row[];
}
export function parseAttempt(value: unknown): Attempt {
  const data = object(value);
  if (data.lane !== "code" && data.lane !== "browser") throw new ReviewAppError("invalid-lane");
  return {
    repo: repository(data.repo),
    pr: integer(data.pr),
    lane: data.lane,
    session: identifier(data.session),
    attempt: identifier(data.attempt),
    H: hash(data.H, 40),
    B: hash(data.B, 40),
    contractDigest: hash(data.contractDigest, 64),
    receipt: string(data.receipt),
  };
}

function identifier(value: unknown): string {
  const result = string(value);
  if (!/^[a-zA-Z0-9_.-]+$/.test(result)) throw new ReviewAppError("invalid-identifier");
  return result;
}
function repository(value: unknown): string {
  const result = string(value);
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(result))
    throw new ReviewAppError("invalid-repository");
  if (result.split("/").some((part) => part === "." || part === ".."))
    throw new ReviewAppError("invalid-repository");
  return result;
}
function hash(value: unknown, length: number): string {
  const result = string(value);
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(result)) throw new ReviewAppError("invalid-hash");
  return result;
}
export function parseConfig(value: unknown): Config {
  const data = object(value);
  if (!Array.isArray(data.repositories) || !data.repositories.length)
    throw new ReviewAppError("invalid-config");
  const app = (value: unknown): AppCredentials => {
    const data = object(value);
    return { appId: integer(data.appId), keyPath: string(data.keyPath) };
  };
  const config = {
    repositories: data.repositories.map(repository),
    receiptRoot: string(data.receiptRoot),
    code: app(data.code),
    browser: app(data.browser),
  };
  if (!config.receiptRoot.startsWith("/") && !config.receiptRoot.startsWith("~/"))
    throw new ReviewAppError("invalid-receipt-root");
  if (config.code.appId === config.browser.appId) throw new ReviewAppError("duplicate-apps");
  return config;
}
export function parseRequest(value: unknown): Request {
  const data = object(value),
    coverage = object(data.coverage);
  const attempt = parseAttempt(value);
  if (data.verdict !== "APPROVED" && data.verdict !== "CHANGES_REQUESTED")
    throw new ReviewAppError("invalid-verdict");
  if (!Array.isArray(data.rows) || !data.rows.length) throw new ReviewAppError("missing-evidence");
  const rows = data.rows.map((value: unknown): Row => {
    const row = object(value);
    if (row.status !== "passed" && row.status !== "failed")
      throw new ReviewAppError("missing-evidence");
    return { status: row.status, evidence: string(row.evidence) };
  });
  const session = attempt.session,
    challenger = identifier(coverage.challenger);
  if (challenger === session || coverage.omissionsClosed !== true)
    throw new ReviewAppError("coverage-incomplete");
  if (data.verdict === "APPROVED" && rows.some((row) => row.status !== "passed"))
    throw new ReviewAppError("failed-scenarios");
  return {
    ...attempt,
    body: string(data.body),
    verdict: data.verdict,
    coverage: { challenger, output: string(coverage.output), omissionsClosed: true },
    rows,
  };
}

function client(config: Config, repo: string, lane: Lane, transport?: typeof fetch): GitHubApp {
  if (!config.repositories.includes(repo)) throw new ReviewAppError("repository-not-allowed");
  return new GitHubApp(config[lane], repo, transport);
}

export async function appStatus(config: Config, repo: string, transport?: typeof fetch) {
  repository(repo);
  const results = [];
  for (const lane of ["code", "browser"] as const) {
    try {
      results.push({
        lane,
        status: "OK",
        ...(await client(config, repo, lane, transport).authenticate()),
      });
    } catch (error) {
      results.push({
        lane,
        status: "BLOCKED",
        reason: error instanceof ReviewAppError ? error.category : "internal",
      });
    }
  }
  return results;
}

export function publishReview(
  config: Config,
  request: Request,
  session: string | undefined,
  transport?: typeof fetch,
) {
  return transitionReview(config, request, session, "publish", transport);
}
export function prepareReview(config: Config, request: Attempt, session: string | undefined) {
  return transitionReview(config, request, session, "prepare");
}
export function blockReview(config: Config, request: Attempt, session: string | undefined) {
  return transitionReview(config, request, session, "block");
}
async function transitionReview(
  config: Config,
  request: Attempt | Request,
  session: string | undefined,
  action: "prepare" | "block" | "publish",
  transport?: typeof fetch,
) {
  if (session !== request.session) throw new ReviewAppError("session-mismatch");
  const app = client(config, request.repo, request.lane, transport);
  const path = `/repos/${request.repo}/pulls/${request.pr}`;
  const expand = (path: string) =>
    resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  let canonical: string;
  try {
    const root = expand(config.receiptRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    canonical = join(
      await realpath(root),
      request.repo.toLowerCase(),
      String(request.pr),
      `${request.lane}.json`,
    );
    await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
    const requested = join(
      await realpath(dirname(expand(request.receipt))),
      request.receipt.split("/").at(-1) ?? "",
    );
    if (requested !== canonical) throw new ReviewAppError("receipt-path-mismatch");
  } catch {
    throw new ReviewAppError("receipt-path-mismatch");
  }
  const lock = `${canonical}.lock`;
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch {
    throw new ReviewAppError("attempt-locked");
  }
  const release = async () => {
    try {
      await handle.close();
      await rm(lock);
    } catch {
      throw new ReviewAppError("receipt-lock-cleanup");
    }
  };
  const receipt = {
    repository: request.repo,
    PR: request.pr,
    lane: request.lane,
    session: request.session,
    attempt: request.attempt,
    H: request.H,
    B: request.B,
    contractDigest: request.contractDigest,
    status: "PENDING",
    localVerdict: action === "publish" && "verdict" in request ? request.verdict : null,
    evidence: action === "publish" && "rows" in request ? request.rows : [],
    coverage: action === "publish" && "coverage" in request ? request.coverage : null,
    reviewId: null as number | null,
    reason: "",
    inputDigest:
      action === "publish" && "body" in request
        ? createHash("sha256")
            .update(
              JSON.stringify({ ...request, receipt: canonical, appId: config[request.lane].appId }),
            )
            .digest("hex")
        : null,
    appId: config[request.lane].appId,
    reviewBlocked: false,
    mutationStarted: false,
    supersededAttempts: [] as string[],
  };
  let ownsAttempt = false;
  const save = async () => {
    const temp = `${canonical}.${request.attempt}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(receipt, null, 2), { mode: 0o600 });
      await rename(temp, canonical);
    } catch {
      throw new ReviewAppError("receipt-write");
    }
  };
  const fresh = async (actor: string) => {
    const pr = object(await app.request(path));
    if (
      object(pr.head).sha !== request.H ||
      object(pr.base).sha !== request.B ||
      pr.state !== "open"
    )
      throw new ReviewAppError("revision-changed");
    if (object(pr.user).login === actor) throw new ReviewAppError("self-author");
  };
  try {
    let previous: unknown;
    try {
      previous = JSON.parse(await readFile(canonical, "utf8")) as unknown;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        throw new ReviewAppError("receipt-state-invalid");
    }
    if (previous !== undefined) {
      const prior = object(previous);
      if (
        prior.repository !== request.repo ||
        prior.PR !== request.pr ||
        prior.lane !== request.lane ||
        !Array.isArray(prior.supersededAttempts) ||
        !prior.supersededAttempts.every(
          (value) => typeof value === "string" && /^[a-zA-Z0-9_.-]+$/.test(value),
        ) ||
        new Set(prior.supersededAttempts).size !== prior.supersededAttempts.length ||
        prior.supersededAttempts.includes(prior.attempt) ||
        typeof prior.attempt !== "string" ||
        !/^[a-zA-Z0-9_.-]+$/.test(prior.attempt) ||
        typeof prior.session !== "string" ||
        !/^[a-zA-Z0-9_.-]+$/.test(prior.session) ||
        typeof prior.H !== "string" ||
        !/^[a-f0-9]{40}$/.test(prior.H) ||
        typeof prior.B !== "string" ||
        !/^[a-f0-9]{40}$/.test(prior.B) ||
        typeof prior.contractDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(prior.contractDigest) ||
        typeof prior.reviewBlocked !== "boolean" ||
        typeof prior.mutationStarted !== "boolean" ||
        typeof prior.reason !== "string" ||
        (prior.localVerdict !== null &&
          prior.localVerdict !== "APPROVED" &&
          prior.localVerdict !== "CHANGES_REQUESTED") ||
        !Array.isArray(prior.evidence) ||
        !prior.evidence.every((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return false;
          const row = object(value);
          return (
            (row.status === "passed" || row.status === "failed") &&
            typeof row.evidence === "string" &&
            row.evidence.length > 0
          );
        }) ||
        (prior.coverage !== null &&
          (() => {
            if (
              !prior.coverage ||
              typeof prior.coverage !== "object" ||
              Array.isArray(prior.coverage)
            )
              return true;
            const coverage = object(prior.coverage);
            return (
              typeof coverage.challenger !== "string" ||
              !/^[a-zA-Z0-9_.-]+$/.test(coverage.challenger) ||
              coverage.challenger === prior.session ||
              typeof coverage.output !== "string" ||
              !coverage.output ||
              coverage.omissionsClosed !== true
            );
          })()) ||
        (prior.reviewId !== null &&
          (!Number.isSafeInteger(prior.reviewId) || Number(prior.reviewId) <= 0)) ||
        !Number.isSafeInteger(prior.appId) ||
        Number(prior.appId) <= 0 ||
        (prior.mutationStarted && prior.inputDigest === null) ||
        (prior.reviewId !== null && !prior.mutationStarted) ||
        (prior.reviewBlocked && prior.status !== "BLOCKED") ||
        (["APPROVED", "CHANGES_REQUESTED"].includes(String(prior.status)) &&
          (prior.inputDigest === null ||
            prior.reviewId === null ||
            prior.localVerdict !== prior.status ||
            prior.coverage === null ||
            prior.evidence.length === 0)) ||
        (prior.inputDigest !== null &&
          (typeof prior.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(prior.inputDigest))) ||
        !["PENDING", "BLOCKED", "APPROVED", "CHANGES_REQUESTED"].includes(String(prior.status))
      )
        throw new ReviewAppError("receipt-state-invalid");
      receipt.supersededAttempts = prior.supersededAttempts;
      if (receipt.supersededAttempts.includes(request.attempt))
        throw new ReviewAppError("attempt-superseded");
      if (prior.attempt === request.attempt) {
        if (
          prior.H !== request.H ||
          prior.B !== request.B ||
          prior.session !== request.session ||
          prior.contractDigest !== request.contractDigest ||
          prior.appId !== receipt.appId
        )
          throw new ReviewAppError("attempt-conflict");
        if (action === "prepare") throw new ReviewAppError("attempt-already-active");
        if (action === "publish" && prior.reviewBlocked)
          throw new ReviewAppError("attempt-blocked");
        if (
          action === "publish" &&
          prior.inputDigest !== null &&
          prior.inputDigest !== receipt.inputDigest
        )
          throw new ReviewAppError("attempt-conflict");
        if (action === "block") receipt.inputDigest = prior.inputDigest;
        receipt.mutationStarted = prior.mutationStarted;
        receipt.reviewId = prior.reviewId === null ? null : integer(prior.reviewId);
      } else {
        if (action !== "prepare") throw new ReviewAppError("attempt-not-current");
        receipt.supersededAttempts = [...receipt.supersededAttempts, prior.attempt];
      }
    } else if (action !== "prepare") throw new ReviewAppError("attempt-not-prepared");
    ownsAttempt = true;
    if (action === "block") {
      receipt.status = "BLOCKED";
      receipt.reason = "review-blocked";
      receipt.reviewBlocked = true;
    }
    await save();
    if (action !== "publish") return receipt;
    if (!("body" in request)) throw new ReviewAppError("invalid-request");
    const access = await app.authenticate();
    await fresh(access.actor);
    const marker = `Spur review attempt: ${request.attempt}`;
    const body = `${request.body}\n\n${marker}\nLane: ${request.lane}\nH: ${request.H}\nB: ${request.B}\nContractDigest: ${request.contractDigest}\nStatus: ${request.verdict}\nScenario evidence: ${JSON.stringify(request.rows)}\nCoverage: ${JSON.stringify(request.coverage)}\n\nWritten by Spur · ${request.session}`;
    const state = request.verdict === "APPROVED" ? "APPROVED" : "CHANGES_REQUESTED";
    const matching = (value: unknown) => {
      const review = object(value);
      return (
        object(review.user).login === access.actor &&
        review.commit_id === request.H &&
        review.body === body &&
        review.state === state
      );
    };
    receipt.status = "BLOCKED";
    await save();
    // Reconcile before mutation too: rerunning a completed attempt must not duplicate its review.
    const history = await app.history(`${path}/reviews`);
    const attemptReviews = history.filter((value) => {
      const review = object(value);
      return (
        object(review.user).login === access.actor &&
        typeof review.body === "string" &&
        review.body.includes(`\n${marker}\n`)
      );
    });
    if (attemptReviews.some((value) => !matching(value)))
      throw new ReviewAppError("attempt-conflict");
    const effective = (rows: unknown[]) =>
      rows
        .map(object)
        .filter(
          (review) =>
            object(review.user).login === access.actor &&
            ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(String(review.state)),
        )
        .sort((a, b) => integer(b.id) - integer(a.id))[0];
    const existing = history.filter(matching);
    let published: unknown;
    if (existing.length > 1) throw new ReviewAppError("duplicate-attempt");
    if (existing.length === 1) {
      if (effective(history)?.id !== object(existing[0]).id)
        throw new ReviewAppError("native-verdict-superseded");
      published = existing[0];
    } else {
      if (receipt.mutationStarted || receipt.reviewId !== null)
        throw new ReviewAppError("publication-uncertain");
      await fresh(access.actor);
      receipt.mutationStarted = true;
      await save();
      try {
        published = await app.request(`${path}/reviews`, "POST", {
          commit_id: request.H,
          event: state === "APPROVED" ? "APPROVE" : "REQUEST_CHANGES",
          body,
        });
      } catch (error) {
        if (
          error instanceof ReviewAppError &&
          ["http-400", "http-401", "http-403", "http-404", "http-422"].includes(error.category)
        ) {
          receipt.mutationStarted = false;
          await save();
          throw error;
        }
        if (
          !(error instanceof ReviewAppError) ||
          !["ambiguous-write", "http-500", "http-502", "http-503", "http-504"].includes(
            error.category,
          )
        )
          throw error;
        const matches = (await app.history(`${path}/reviews`)).filter(matching);
        if (matches.length !== 1) throw new ReviewAppError("publication-uncertain");
        published = matches[0];
      }
    }
    const id = integer(object(published).id);
    receipt.mutationStarted = true;
    receipt.reviewId = id;
    await save();
    const readback = await app.request(`${path}/reviews/${id}`);
    if (!matching(published) || !matching(readback) || integer(object(readback).id) !== id)
      throw new ReviewAppError("review-mismatch");
    await fresh(access.actor);
    const current = effective(await app.history(`${path}/reviews`));
    if (!current || current.id !== id || !matching(current))
      throw new ReviewAppError("native-verdict-superseded");
    await fresh(access.actor);
    receipt.status = request.verdict;
    await save();
    return receipt;
  } catch (error) {
    if (!ownsAttempt) throw error;
    receipt.status = "BLOCKED";
    receipt.reason = error instanceof ReviewAppError ? error.category : "internal";
    await save();
    return receipt;
  } finally {
    await release();
  }
}

export function registerReviewApp(program: Command): void {
  const command = program
    .command("review-app")
    .description("Authenticate reviewer Apps and publish pinned native reviews.");
  for (const action of ["prepare", "block"] as const) {
    command
      .command(action)
      .requiredOption("--app-config <file>")
      .requiredOption("--request <file>")
      .option("--json")
      .action(async (options: { appConfig: string; request: string }) => {
        const config = parseConfig(await readJson(options.appConfig));
        const request = parseAttempt(await readJson(options.request));
        const result = await transitionReview(config, request, process.env["SPUR_SESSION"], action);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      });
  }
  command
    .command("status")
    .requiredOption("--app-config <file>")
    .requiredOption("--repo <owner/name>")
    .option("--json")
    .action(async (options: { appConfig: string; repo: string }) => {
      const result = await appStatus(parseConfig(await readJson(options.appConfig)), options.repo);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.some((row) => row.status !== "OK")) process.exitCode = 1;
    });
  command
    .command("publish")
    .requiredOption("--app-config <file>")
    .requiredOption("--request <file>")
    .option("--json")
    .action(async (options: { appConfig: string; request: string }) => {
      const result = await publishReview(
        parseConfig(await readJson(options.appConfig)),
        parseRequest(await readJson(options.request)),
        process.env["SPUR_SESSION"],
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status === "BLOCKED") process.exitCode = 1;
    });
}

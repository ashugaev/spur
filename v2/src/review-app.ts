import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  code: AppCredentials;
  browser: AppCredentials;
}
interface Row {
  status: "passed" | "failed";
  evidence: string;
}
interface Request {
  repo: string;
  pr: number;
  lane: Lane;
  session: string;
  attempt: string;
  H: string;
  B: string;
  contractDigest: string;
  body: string;
  receipt: string;
  verdict: "APPROVED" | "CHANGES_REQUESTED";
  coverage: { challenger: string; output: string; omissionsClosed: boolean };
  rows: Row[];
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
    code: app(data.code),
    browser: app(data.browser),
  };
  if (config.code.appId === config.browser.appId) throw new ReviewAppError("duplicate-apps");
  return config;
}
export function parseRequest(value: unknown): Request {
  const data = object(value),
    coverage = object(data.coverage);
  if (data.lane !== "code" && data.lane !== "browser") throw new ReviewAppError("invalid-lane");
  if (data.verdict !== "APPROVED" && data.verdict !== "CHANGES_REQUESTED")
    throw new ReviewAppError("invalid-verdict");
  if (!Array.isArray(data.rows) || !data.rows.length) throw new ReviewAppError("missing-evidence");
  const rows = data.rows.map((value: unknown): Row => {
    const row = object(value);
    if (row.status !== "passed" && row.status !== "failed")
      throw new ReviewAppError("missing-evidence");
    return { status: row.status, evidence: string(row.evidence) };
  });
  const session = identifier(data.session),
    challenger = identifier(coverage.challenger);
  if (challenger === session || coverage.omissionsClosed !== true)
    throw new ReviewAppError("coverage-incomplete");
  if (data.verdict === "APPROVED" && rows.some((row) => row.status !== "passed"))
    throw new ReviewAppError("failed-scenarios");
  return {
    repo: repository(data.repo),
    pr: integer(data.pr),
    lane: data.lane,
    session,
    attempt: identifier(data.attempt),
    H: hash(data.H, 40),
    B: hash(data.B, 40),
    contractDigest: hash(data.contractDigest, 64),
    body: string(data.body),
    receipt: string(data.receipt),
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

export async function publishReview(
  config: Config,
  request: Request,
  session: string | undefined,
  transport?: typeof fetch,
) {
  if (session !== request.session) throw new ReviewAppError("session-mismatch");
  const app = client(config, request.repo, request.lane, transport);
  const path = `/repos/${request.repo}/pulls/${request.pr}`;
  const lock = `${request.receipt}.lock`;
  try {
    await mkdir(dirname(request.receipt), { recursive: true, mode: 0o700 });
  } catch {
    throw new ReviewAppError("receipt-write");
  }
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
    localVerdict: request.verdict,
    evidence: request.rows,
    coverage: request.coverage,
    reviewId: null as number | null,
    reason: "",
  };
  const save = async () => {
    const temp = `${request.receipt}.${request.attempt}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(receipt, null, 2), { mode: 0o600 });
      await rename(temp, request.receipt);
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
    await save();
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
    const existing = (await app.history(`${path}/reviews`)).filter(matching);
    let published: unknown;
    if (existing.length > 1) throw new ReviewAppError("duplicate-attempt");
    if (existing.length === 1) published = existing[0];
    else {
      await fresh(access.actor);
      try {
        published = await app.request(`${path}/reviews`, "POST", {
          commit_id: request.H,
          event: state === "APPROVED" ? "APPROVE" : "REQUEST_CHANGES",
          body,
        });
      } catch (error) {
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
    const readback = await app.request(`${path}/reviews/${id}`);
    if (!matching(published) || !matching(readback) || integer(object(readback).id) !== id)
      throw new ReviewAppError("review-mismatch");
    receipt.reviewId = id;
    await fresh(access.actor);
    receipt.status = request.verdict;
    await save();
    return receipt;
  } catch (error) {
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

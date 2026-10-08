import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parse } from "yaml";
import { integer, object, string, ReviewAppError } from "./github-app.js";
import {
  GateGitHub,
  readGateSnapshot,
  evaluateSnapshot,
  workflowPath,
  type GatePolicy,
} from "./review-gate.js";

type WakeTarget = { number?: number; head?: string };

export async function verifyWake(
  api: GateGitHub,
  repo: string,
  event: string,
  payload: unknown,
): Promise<WakeTarget> {
  if (["issue_comment", "pull_request_target"].includes(event)) {
    const data = object(payload);
    const pr = event === "issue_comment" ? object(data.issue) : object(data.pull_request);
    if (event === "issue_comment" && !pr.pull_request) return {};
    return { number: integer(pr.number) };
  }
  if (["push", "workflow_dispatch"].includes(event)) return {};
  if (event !== "workflow_run") throw new ReviewAppError("unauthorized-gate-event");
  const hint = object(object(payload).workflow_run);
  const run = object(await api.request(`/repos/${repo}/actions/runs/${integer(hint.id)}`));
  if (
    object(run.repository).full_name !== repo ||
    !["pull_request", "pull_request_review", "push", "workflow_dispatch"].includes(
      String(run.event),
    ) ||
    run.run_attempt !== hint.run_attempt
  )
    throw new ReviewAppError("unauthorized-upstream-run");
  const file = run.event === "pull_request_review" ? "review-wake.yml" : "ci.yml";
  const workflow = object(await api.request(`/repos/${repo}/actions/workflows/${file}`));
  if (
    run.workflow_id !== workflow.id ||
    workflowPath(run.path) !== `.github/workflows/${file}` ||
    workflow.path !== workflowPath(run.path)
  )
    throw new ReviewAppError("unauthorized-upstream-workflow");
  // An upstream run wakes reconciliation only. Its conclusion, PR list and artifacts grant no verdict.
  return typeof run.head_sha === "string" && /^[a-f0-9]{40}$/.test(run.head_sha)
    ? { head: run.head_sha }
    : {};
}
export async function produceGates(
  api: GateGitHub,
  policy: GatePolicy,
  target: WakeTarget = {},
): Promise<void> {
  const started = Date.now();
  const active = () => {
    if (api.scopeSignal?.aborted) throw new ReviewAppError("gate-reconciliation-timeout");
  };
  active();
  process.stderr.write(`${JSON.stringify({ phase: "candidate-list" })}\n`);
  const prs = await api.pages(`/repos/${policy.repository}/pulls?state=open`);
  active();
  const matches = (candidate: Record<string, unknown>) =>
    target.number !== undefined
      ? candidate.number === target.number
      : target.head !== undefined &&
        candidate.head !== null &&
        typeof candidate.head === "object" &&
        !Array.isArray(candidate.head) &&
        object(candidate.head).sha === target.head;
  prs.sort(
    (a, b) =>
      Number(matches(b)) - Number(matches(a)) ||
      String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) ||
      Number(a.number) - Number(b.number),
  );
  if (!prs.some(matches))
    process.stderr.write(`${JSON.stringify({ phase: "wake-target-unavailable" })}\n`);
  let incomplete = false;
  for (const candidate of prs) {
    active();
    let checkId: number | undefined;
    let phase = "candidate-read";
    const progress = (category?: string, outcome?: string) =>
      process.stderr.write(
        `${JSON.stringify({
          pr: Number.isSafeInteger(candidate.number) ? candidate.number : undefined,
          checkId,
          phase,
          elapsedMs: Date.now() - started,
          category,
          outcome,
        })}\n`,
      );
    const path = `/repos/${policy.repository}/check-runs`;
    try {
      const number = integer(candidate.number);
      const pr = object(await api.request(`/repos/${policy.repository}/pulls/${number}`));
      active();
      const H = string(object(pr.head).sha),
        B = string(object(pr.base).sha);
      phase = "check-create";
      progress();
      const check = object(
        await api.request(path, "POST", {
          name: "Spur Approval Gate",
          head_sha: H,
          status: "in_progress",
          external_id: `${number}:${H}:${B}`,
        }),
      );
      if (
        check.name !== "Spur Approval Gate" ||
        check.head_sha !== H ||
        object(check.app).slug !== "github-actions"
      )
        throw new ReviewAppError("unverified-check-writer");
      checkId = integer(check.id);
      active();
      phase = "snapshot-before";
      progress();
      const before = await readGateSnapshot(api, policy, number);
      active();
      const result = evaluateSnapshot(policy, number, before);
      phase = "snapshot-after";
      progress();
      const after = evaluateSnapshot(policy, number, await readGateSnapshot(api, policy, number));
      active();
      const fresh =
        result.fingerprint === after.fingerprint &&
        result.H === H &&
        result.B === B &&
        result.H === after.H &&
        result.B === after.B;
      const approved = fresh && result.status === "APPROVED" && after.status === "APPROVED";
      phase = "completion-write";
      progress();
      active();
      await api.request(`${path}/${integer(check.id)}`, "PATCH", {
        status: "completed",
        conclusion: approved ? "success" : "failure",
        output: {
          title: approved ? "All approval gates pass" : "Approval blocked",
          summary: fresh ? after.reason : "Evidence changed during evaluation",
        },
      });
      active();
      phase = "completion-confirmed";
      progress();
    } catch (error) {
      if (api.scopeSignal?.aborted) {
        progress(
          "gate-reconciliation-timeout",
          phase === "completion-write" ? "UNKNOWN" : undefined,
        );
        throw new ReviewAppError("gate-reconciliation-timeout");
      }
      progress(error instanceof ReviewAppError ? error.category : "gate-candidate-unavailable");
      incomplete = true;
      if (checkId !== undefined) {
        try {
          active();
          phase = "failure-write";
          progress();
          await api.request(`${path}/${checkId}`, "PATCH", {
            status: "completed",
            conclusion: "failure",
            output: { title: "Approval blocked", summary: "Candidate evidence unavailable" },
          });
          active();
        } catch {
          if (api.scopeSignal?.aborted) progress("gate-reconciliation-timeout", "UNKNOWN");
          active();
          /* An unconfirmed completion leaves the candidate's check in progress. */
        }
      }
    }
  }
  active();
  if (incomplete) throw new ReviewAppError("gate-reconciliation-incomplete");
}
export async function runProducer(env: NodeJS.ProcessEnv): Promise<void> {
  const signal = AbortSignal.timeout(15 * 60_000);
  const repo = string(env.GITHUB_REPOSITORY);
  const api = new GateGitHub(string(env.GITHUB_TOKEN), undefined, signal);
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(string(env.GITHUB_EVENT_PATH), "utf8"));
  } catch {
    throw new ReviewAppError("invalid-gate-event");
  }
  process.stderr.write(`${JSON.stringify({ phase: "wake-validation" })}\n`);
  const target = await verifyWake(api, repo, string(env.GITHUB_EVENT_NAME), payload);
  const ciPath = resolve(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)));
  const definition = object(parse(await readFile(ciPath, "utf8")));
  const jobs = Object.values(object(definition.jobs)).map((value) => string(object(value).name));
  const workflow = object(await api.request(`/repos/${repo}/actions/workflows/ci.yml`));
  if (workflow.path !== ".github/workflows/ci.yml")
    throw new ReviewAppError("ci-workflow-mismatch");
  const repository = object(await api.request(`/repos/${repo}`));
  const policy: GatePolicy = {
    repository: repo,
    baseBranch: string(repository.default_branch),
    codeActor: integer(Number(env.SPUR_CODE_REVIEW_ACTOR)),
    browserActor: integer(Number(env.SPUR_BROWSER_REVIEW_ACTOR)),
    ciWorkflowId: integer(workflow.id),
    ciJobs: jobs,
  };
  if (policy.codeActor === policy.browserActor) throw new ReviewAppError("duplicate-review-actors");
  await produceGates(api, policy, target);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProducer(process.env).catch((error: unknown) => {
    process.stderr.write(`${error instanceof ReviewAppError ? error.category : "gate-internal"}\n`);
    process.exitCode = 1;
  });
}

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parse } from "yaml";
import { integer, object, string, ReviewAppError } from "./github-app.js";
import { GateGitHub, readGateSnapshot, evaluateSnapshot, type GatePolicy } from "./review-gate.js";

export async function verifyWake(
  api: GateGitHub,
  repo: string,
  event: string,
  payload: unknown,
): Promise<void> {
  if (["issue_comment", "pull_request_target", "push", "workflow_dispatch"].includes(event)) return;
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
    run.path !== `.github/workflows/${file}` ||
    workflow.path !== run.path
  )
    throw new ReviewAppError("unauthorized-upstream-workflow");
  // An upstream run wakes reconciliation only. Its conclusion, PR list and artifacts grant no verdict.
}
export async function produceGates(api: GateGitHub, policy: GatePolicy): Promise<void> {
  const prs = await api.pages(`/repos/${policy.repository}/pulls?state=open`);
  for (const candidate of prs) {
    const number = integer(candidate.number);
    const pr = object(await api.request(`/repos/${policy.repository}/pulls/${number}`));
    const H = string(object(pr.head).sha),
      B = string(object(pr.base).sha);
    const path = `/repos/${policy.repository}/check-runs`;
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
    const before = await readGateSnapshot(api, policy, number);
    const result = evaluateSnapshot(policy, number, before);
    const after = evaluateSnapshot(policy, number, await readGateSnapshot(api, policy, number));
    const fresh =
      result.fingerprint === after.fingerprint &&
      result.H === H &&
      result.B === B &&
      result.H === after.H &&
      result.B === after.B;
    const approved = fresh && result.status === "APPROVED" && after.status === "APPROVED";
    await api.request(`${path}/${integer(check.id)}`, "PATCH", {
      status: "completed",
      conclusion: approved ? "success" : "failure",
      output: {
        title: approved ? "All approval gates pass" : "Approval blocked",
        summary: fresh ? after.reason : "Evidence changed during evaluation",
      },
    });
  }
}
export async function runProducer(env: NodeJS.ProcessEnv): Promise<void> {
  const repo = string(env.GITHUB_REPOSITORY);
  const api = new GateGitHub(string(env.GITHUB_TOKEN));
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(string(env.GITHUB_EVENT_PATH), "utf8"));
  } catch {
    throw new ReviewAppError("invalid-gate-event");
  }
  await verifyWake(api, repo, string(env.GITHUB_EVENT_NAME), payload);
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
  await produceGates(api, policy);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProducer(process.env).catch((error: unknown) => {
    process.stderr.write(`${error instanceof ReviewAppError ? error.category : "gate-internal"}\n`);
    process.exitCode = 1;
  });
}

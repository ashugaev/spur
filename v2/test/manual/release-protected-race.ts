import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Native destructive proof runner. Provision the disposable repository and
// runner controls separately; this runner never installs or weakens protection.
const requiredNames = [
  "Quality",
  "Playwright E2E",
  "Runtime Integration",
  "Real-Agent Smoke",
  "Spur Strict CI",
];
const scenarios = [
  "stale-head",
  "stale-base",
  "blocking-review",
  "unresolved-thread",
  "dependency-skip",
  "neutral",
  "cancelled",
  "whole-run-skip",
  "rerun",
  "duplicate",
  "out-of-order",
  "new-attempt-old-green",
  "positive-two-app",
];
type ObjectValue = Record<string, unknown>;
type Mutation = { path: string; method: "POST" | "PATCH" | "PUT"; body: ObjectValue };
type Case = { name: string; pr: number; head: string; base: string; mutations: Mutation[] };
type Config = {
  repository: string;
  disposable: true;
  workflowId: number;
  sourceDigest: string;
  approvalContext: string;
  approvalAppId: number;
  laneAppIds: number[];
  laneAppSlugs: string[];
  cases: Case[];
};
type Reply = { status: number; data: unknown };

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected string");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Expected positive integer");
  return value;
}
function json(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid JSON");
  }
}
function sha(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error("Invalid revision");
  return result;
}
export function parseSandboxConfig(value: unknown): Config {
  const input = object(value);
  const repository = string(input.repository);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.toLowerCase() === "ashugaev/spur" ||
    input.disposable !== true
  )
    throw new Error("Explicit disposable sandbox required");
  const sourceDigest = string(input.sourceDigest);
  if (!/^[a-f0-9]{64}$/.test(sourceDigest)) throw new Error("Invalid source digest");
  const cases = array(input.cases).map((value) => {
    const row = object(value);
    const name = string(row.name);
    if (!scenarios.includes(name)) throw new Error("Unknown native scenario");
    const pr = number(row.pr);
    const mutations = array(row.mutations).map((value): Mutation => {
      const mutation = object(value);
      const path = string(mutation.path);
      const method = mutation.method;
      // No arbitrary commands, external URL, check forging, force-push,
      // protection mutation or credential payload. All operations stay scoped.
      const allowed = [
        /^actions\/runs\/\d+\/(rerun|rerun-failed-jobs|cancel)$/,
        /^actions\/workflows\/\d+\/dispatches$/,
        new RegExp(`^pulls/${pr}/reviews$`),
        /^git\/refs\/heads\/[A-Za-z0-9_.-]+$/,
        /^contents\/[A-Za-z0-9_./-]+$/,
      ];
      if (
        !allowed.some((pattern) => pattern.test(path)) ||
        (method !== "POST" && method !== "PATCH" && method !== "PUT")
      )
        throw new Error("Unsupported sandbox mutation");
      const body = object(mutation.body);
      if (body.force === true || /token|secret|password/i.test(JSON.stringify(Object.keys(body))))
        throw new Error("Unsafe sandbox mutation");
      return { path, method, body };
    });
    return { name, pr, head: sha(row.head), base: sha(row.base), mutations };
  });
  if (
    cases.length !== scenarios.length ||
    new Set(cases.map((row) => row.name)).size !== scenarios.length ||
    new Set(cases.map((row) => row.pr)).size !== scenarios.length
  )
    throw new Error("Provide one isolated PR per native scenario");
  const laneAppIds = array(input.laneAppIds).map(number);
  if (laneAppIds.length !== 2 || new Set(laneAppIds).size !== 2)
    throw new Error("Two distinct designated lane Apps required");
  const laneAppSlugs = array(input.laneAppSlugs).map(string);
  if (
    laneAppSlugs.length !== 2 ||
    new Set(laneAppSlugs).size !== 2 ||
    laneAppSlugs.some((slug) => !/^[a-z0-9-]+$/.test(slug))
  )
    throw new Error("Two designated App slugs required");
  return {
    repository,
    disposable: true,
    workflowId: number(input.workflowId),
    sourceDigest,
    approvalContext: string(input.approvalContext),
    approvalAppId: number(input.approvalAppId),
    laneAppIds,
    laneAppSlugs,
    cases,
  };
}

async function api(path: string, method = "GET", body?: ObjectValue): Promise<Reply> {
  const args = ["api", "--include", "--method", method, path];
  if (body) {
    args.push("--input", "-");
  }
  // execFile has no input option: use JSON fields for typed REST payloads.
  // gh -F parses JSON objects only with --input, so feed stdin explicitly.
  const child = execFile("gh", args, { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
  if (body) child.stdin?.end(JSON.stringify(body));
  const output = await new Promise<string>((resolveOutput, reject) => {
    let stdout = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => reject(new Error("Sandbox API transport failed")));
    child.on("close", () => resolveOutput(stdout));
  });
  const match = /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(output);
  if (!match) throw new Error("Sandbox API response missing HTTP status");
  return { status: Number(match[1]), data: match[2]?.trim() ? json(match[2]) : null };
}
async function get(path: string): Promise<unknown> {
  const reply = await api(path);
  if (reply.status !== 200) throw new Error("Sandbox read failed");
  return reply.data;
}
async function pages(path: string, field?: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = array(field ? object(response)[field] : response);
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw new Error("Sandbox pagination incomplete");
}
async function snapshot(cfg: Config, row: Case) {
  const root = `repos/${cfg.repository}`;
  const pr = object(await get(`${root}/pulls/${row.pr}`));
  const head = object(pr.head);
  const base = object(pr.base);
  const revision = sha(head.sha);
  const checks = (
    await pages(`${root}/commits/${revision}/check-runs?filter=all`, "check_runs")
  ).map((value) => {
    const check = object(value);
    return {
      id: number(check.id),
      name: string(check.name),
      status: string(check.status),
      conclusion: check.conclusion,
      appId: number(object(check.app).id),
      suiteId: number(object(check.check_suite).id),
    };
  });
  const runs = (
    await pages(
      `${root}/actions/workflows/${cfg.workflowId}/runs?event=pull_request`,
      "workflow_runs",
    )
  )
    .map((value) => {
      const run = object(value);
      return {
        id: number(run.id),
        attempt: number(run.run_attempt),
        head: sha(run.head_sha),
        suiteId: number(run.check_suite_id),
        status: string(run.status),
        conclusion: run.conclusion,
        path: string(run.path),
        event: string(run.event),
      };
    })
    .filter((run) => checks.some((check) => check.suiteId === run.suiteId));
  const rules = await get(`${root}/rules/branches/main`);
  const reviews = (await pages(`${root}/pulls/${row.pr}/reviews`)).map((value) => {
    const review = object(value);
    const author = object(review.user);
    return {
      id: number(review.id),
      state: string(review.state),
      head: sha(review.commit_id),
      userId: number(author.id),
      login: string(author.login),
      type: string(author.type),
    };
  });
  const [owner, repository] = cfg.repository.split("/");
  const threadsReply = await api("graphql", "POST", {
    query:
      "query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved} pageInfo{hasNextPage}}}}}",
    variables: { owner, name: repository, pr: row.pr },
  });
  const threads = object(object(object(object(threadsReply.data).data).repository).pullRequest);
  const connection = object(threads.reviewThreads);
  if (threadsReply.status !== 200 || object(connection.pageInfo).hasNextPage !== false)
    throw new Error("Incomplete native thread evidence");
  const unresolved = array(connection.nodes)
    .map(object)
    .filter((thread) => thread.isResolved !== true).length;
  return {
    head: revision,
    base: sha(base.sha),
    baseRef: string(base.ref),
    headRepository: string(object(head.repo).full_name),
    authorId: number(object(pr.user).id),
    checks,
    runs,
    rules,
    reviews,
    unresolved,
  };
}
function validateRules(value: unknown, cfg: Config): void {
  const rules = array(value).map(object);
  for (const type of ["deletion", "non_fast_forward", "required_linear_history"]) {
    if (!rules.some((rule) => rule.type === type))
      throw new Error("Missing protected main invariant");
  }
  const checks = rules.find((rule) => rule.type === "required_status_checks");
  const parameters = object(checks?.parameters);
  if (parameters.strict_required_status_checks_policy !== true)
    throw new Error("Strict main required");
  const contexts = array(parameters.required_status_checks).map(object);
  for (const name of requiredNames) {
    if (!contexts.some((context) => context.context === name && context.integration_id === 15368))
      throw new Error("Missing native required CI context");
  }
  if (
    !contexts.some(
      (context) =>
        context.context === cfg.approvalContext && context.integration_id === cfg.approvalAppId,
    )
  )
    throw new Error("Missing source-bound Approval Gate");
  const pull = object(rules.find((rule) => rule.type === "pull_request")?.parameters);
  if (
    pull.required_review_thread_resolution !== true ||
    !array(pull.allowed_merge_methods).every((method) => method === "squash") ||
    array(pull.allowed_merge_methods).length !== 1
  )
    throw new Error("Squash/thread protection required");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--sandbox-config" || args[2] !== "--output")
    throw new Error("Use --sandbox-config <private.json> --output <artifact.json>");
  const artifacts = process.env.SPUR_SESSION_ARTIFACTS_DIR;
  if (!artifacts) throw new Error("Session artifacts required");
  const output = resolve(string(args[3]));
  const rootDir = await realpath(artifacts);
  const outputDir = await realpath(dirname(output));
  const local = relative(rootDir, outputDir);
  if (local.startsWith("..") || isAbsolute(local))
    throw new Error("Output must stay inside session artifacts");
  const cfg = parseSandboxConfig(json(await readFile(string(args[1]), "utf8")));
  const root = `repos/${cfg.repository}`;
  const repo = object(await get(root));
  const user = object(await get("user"));
  if (repo.default_branch !== "main" || repo.archived === true)
    throw new Error("Sandbox default main required");
  const access = object(
    await get(`${root}/collaborators/${encodeURIComponent(string(user.login))}/permission`),
  );
  if (access.permission !== "write")
    throw new Error("Use a non-admin non-bypass sandbox merge actor");
  for (const [index, slug] of cfg.laneAppSlugs.entries()) {
    if (number(object(await get(`apps/${slug}`)).id) !== cfg.laneAppIds[index])
      throw new Error("Designated native App identity mismatch");
  }
  const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== cfg.sourceDigest) throw new Error("Reviewed CI fixture digest mismatch");
  const fixture = object(await get(`${root}/contents/.github/workflows/ci.yml?ref=main`));
  if (
    fixture.encoding !== "base64" ||
    createHash("sha256")
      .update(Buffer.from(string(fixture.content), "base64"))
      .digest("hex") !== digest
  )
    throw new Error("Sandbox must copy exact reviewed workflow");
  const receipts: ObjectValue[] = [];
  const save = async (status: string) =>
    writeFile(
      output,
      JSON.stringify(
        { version: 1, native: true, status, sourceDigest: digest, receipts },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  await save("running");
  for (const row of cfg.cases) {
    const before = await snapshot(cfg, row);
    validateRules(before.rules, cfg);
    const rulesetIds = new Set(
      array(before.rules).map((value) => number(object(value).ruleset_id)),
    );
    for (const id of rulesetIds) {
      const ruleset = object(await get(`${root}/rulesets/${id}`));
      if (ruleset.enforcement !== "active" || array(ruleset.bypass_actors).length !== 0)
        throw new Error("Sandbox protection must have no bypass actors");
    }
    if (
      before.baseRef !== "main" ||
      before.headRepository.toLowerCase() !== cfg.repository.toLowerCase() ||
      before.head !== row.head ||
      before.base !== row.base
    )
      throw new Error("Scenario H/B/repository mismatch");
    const commit = object(await get(`${root}/git/commits/${row.head}`));
    const parents = array(commit.parents).map((value) => sha(object(value).sha));
    if (parents.length !== 1 || parents[0] !== row.base)
      throw new Error("Reviewed H must have exactly one parent B");
    for (const name of [...requiredNames, cfg.approvalContext]) {
      const matches = before.checks.filter((check) => check.name === name);
      if (
        matches.length !== 1 ||
        matches[0]?.conclusion !== "success" ||
        matches[0]?.status !== "completed" ||
        matches[0]?.appId !== (name === cfg.approvalContext ? cfg.approvalAppId : 15368)
      )
        throw new Error("Final owner barrier is not exact successful native evidence");
    }
    if (before.unresolved !== 0) throw new Error("Final owner barrier has unresolved threads");
    const strict = before.checks.find((check) => check.name === "Spur Strict CI");
    if (!strict) throw new Error("Missing strict native check");
    const suite = object(await get(`${root}/check-suites/${strict.suiteId}`));
    const synthetic = object(await get(`${root}/git/commits/${sha(suite.head_sha)}`));
    if (
      JSON.stringify(array(synthetic.parents).map((value) => sha(object(value).sha))) !==
      JSON.stringify([row.base, row.head])
    )
      throw new Error("Native aggregate must bind exact synthetic B/H parents");
    const boundRuns = before.runs.filter(
      (run) =>
        run.suiteId === strict.suiteId &&
        run.path === ".github/workflows/ci.yml" &&
        run.event === "pull_request",
    );
    if (
      boundRuns.length !== 1 ||
      boundRuns[0]?.status !== "completed" ||
      boundRuns[0]?.conclusion !== "success"
    )
      throw new Error("Native run provenance missing");
    const lanes = cfg.laneAppSlugs.map((slug) =>
      before.reviews.filter(
        (review) =>
          review.login === `${slug}[bot]` &&
          review.type === "Bot" &&
          review.userId !== before.authorId &&
          review.head === row.head &&
          review.state === "APPROVED",
      ),
    );
    if (lanes.some((lane) => lane.length !== 1) || lanes[0]?.[0]?.userId === lanes[1]?.[0]?.userId)
      throw new Error("Distinct current native designated lane approvals required");
    const barrier = new Date().toISOString();
    const mutationStatuses: number[] = [];
    for (const mutation of row.mutations) {
      const reply = await api(`${root}/${mutation.path}`, mutation.method, mutation.body);
      mutationStatuses.push(reply.status);
      if (reply.status < 200 || reply.status >= 300)
        throw new Error("Adversarial sandbox mutation failed");
    }
    const after = await snapshot(cfg, row);
    validateRules(after.rules, cfg);
    if (row.name === "stale-head" && after.head === before.head)
      throw new Error("Head race not introduced");
    if (row.name === "stale-base" && after.base === before.base)
      throw new Error("Base race not introduced");
    if (
      row.name === "blocking-review" &&
      !after.reviews.some(
        (review) =>
          review.state === "CHANGES_REQUESTED" &&
          review.head === row.head &&
          !before.reviews.some((old) => old.id === review.id),
      )
    )
      throw new Error("Blocking native review not introduced");
    if (row.name === "unresolved-thread" && after.unresolved === 0)
      throw new Error("Unresolved native thread not introduced");
    const conclusion =
      row.name === "dependency-skip"
        ? "skipped"
        : row.name === "neutral"
          ? "neutral"
          : row.name === "cancelled"
            ? "cancelled"
            : null;
    if (
      conclusion &&
      !after.checks.some(
        (check) =>
          requiredNames.includes(check.name) &&
          check.conclusion === conclusion &&
          !before.checks.some((old) => old.id === check.id && old.conclusion === conclusion),
      )
    )
      throw new Error("Required native execution conclusion not introduced");
    if (
      ["rerun", "duplicate", "out-of-order", "new-attempt-old-green", "whole-run-skip"].includes(
        row.name,
      ) &&
      !after.runs.some(
        (run) => !before.runs.some((old) => old.id === run.id && old.attempt === run.attempt),
      )
    )
      throw new Error("New native attempt not observed; runner barrier control required");
    if (
      ["duplicate", "out-of-order", "new-attempt-old-green"].includes(row.name) &&
      !after.checks.some((check) => check.id === strict.id && check.conclusion === "success")
    )
      throw new Error("Old strict green reuse not retained at action barrier");
    if (
      row.name === "duplicate" &&
      !after.runs.some((run) => !before.runs.some((old) => old.id === run.id))
    )
      throw new Error("Distinct duplicate native run missing");
    const approval = before.checks.find((check) => check.name === cfg.approvalContext);
    if (!approval) throw new Error("Missing native approval context");
    if (!after.checks.some((check) => check.id === approval.id && check.conclusion === "success"))
      throw new Error("Old green Approval Gate must remain present");
    const baseAtAction = object(await get(`${root}/git/ref/heads/main`));
    const baseSha = sha(object(baseAtAction.object).sha);
    const merge = await api(`${root}/pulls/${row.pr}/merge`, "PUT", {
      sha: row.head,
      merge_method: "squash",
    });
    const finalBase = sha(object(object(await get(`${root}/git/ref/heads/main`)).object).sha);
    const positive = row.name === "positive-two-app";
    const merged = merge.status === 200 && object(merge.data).merged === true;
    receipts.push({
      scenario: row.name,
      pr: row.pr,
      barrier,
      requestedHead: row.head,
      parent: row.base,
      before,
      mutationStatuses,
      after,
      actionBase: baseSha,
      mergeStatus: merge.status,
      merged,
      finalBase,
    });
    await save("running");
    if (
      (!positive && (merged || ![405, 409, 422].includes(merge.status) || finalBase !== baseSha)) ||
      (positive && (!merged || finalBase === baseSha))
    ) {
      await save("failed-native-enforcement");
      throw new Error(
        "Native action proof failed; stop sandbox mutations and keep activation blocked",
      );
    }
  }
  await save("sampled-native-results-only-requires-independent-ordering-assessment");
}

// Silence subprocess stderr and report only stable errors; credentials, private
// config paths and operator environment never enter the artifact or console.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write("Protected sandbox proof failed; activation remains blocked\n");
    process.exitCode = 1;
  });
}

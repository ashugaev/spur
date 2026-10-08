import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { expect, test, vi } from "vitest";
import { GateGitHub } from "../../src/review-gate.js";
import { produceGates, runProducer, verifyWake } from "../../src/review-gate-producer.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const policy = {
  repository: "owner/repo",
  baseBranch: "main",
  codeActor: 11,
  browserActor: 12,
  ciWorkflowId: 1,
  ciJobs: ["Quality"],
};

test("shared budget stops cumulative pagination and in-flight reads without starting mutations", async () => {
  vi.useFakeTimers();
  const trace = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const controller = new AbortController();
  const transport = vi.fn<typeof fetch>(async (_url, options) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      options?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
    return Response.json(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })));
  });
  try {
    setTimeout(() => controller.abort(), 250);
    const result = expect(
      produceGates(new GateGitHub("fixture", transport, controller.signal), policy),
    ).rejects.toThrow("gate-reconciliation-timeout");
    await vi.advanceTimersByTimeAsync(300);
    await result;
    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(transport).toHaveBeenCalledTimes(3);
  } finally {
    trace.mockRestore();
    vi.useRealTimers();
  }
});

test.each(["pre-aborted", "body", "transport"])(
  "scope signal guards %s without swallowing ordinary failures",
  async (mode) => {
    const controller = new AbortController();
    let bodyRead = false;
    const transport = vi.fn<typeof fetch>(async () => {
      if (mode === "transport") throw new Error("ordinary failure");
      const response = new Response(
        new ReadableStream({
          start(stream) {
            queueMicrotask(() => {
              queueMicrotask(() => {
                controller.abort();
                stream.error(new Error("body aborted"));
              });
            });
          },
        }),
      );
      const json = response.json.bind(response);
      vi.spyOn(response, "json").mockImplementation(() => {
        bodyRead = true;
        return json();
      });
      return response;
    });
    if (mode === "pre-aborted") controller.abort();
    await expect(
      new GateGitHub("fixture", transport, controller.signal).request("/fixture"),
    ).rejects.toThrow(mode === "transport" ? "gate-network" : "gate-reconciliation-timeout");
    expect(transport).toHaveBeenCalledTimes(mode === "pre-aborted" ? 0 : 1);
    if (mode === "body") expect(bodyRead).toBe(true);
  },
);

test.each(["head", "head-budget", "direct", "missing", "mismatched"])(
  "wake priority %s retains all real open candidates",
  async (mode) => {
    const head = "a".repeat(40);
    const controller = new AbortController();
    const relay: typeof fetch = async (url) =>
      Response.json(
        String(url).includes("/runs/")
          ? {
              id: 1,
              repository: { full_name: "owner/repo" },
              event: "pull_request_review",
              workflow_id: 2,
              path: ".github/workflows/review-wake.yml",
              run_attempt: 1,
              head_sha: head,
              pull_requests: [],
            }
          : { id: 2, path: ".github/workflows/review-wake.yml" },
      );
    const api = new GateGitHub("fixture", relay, controller.signal);
    const target =
      mode === "direct"
        ? await verifyWake(api, "owner/repo", "pull_request_target", {
            pull_request: { number: 2 },
          })
        : mode === "missing"
          ? { number: 999 }
          : mode === "mismatched"
            ? { head: "b".repeat(40) }
            : await verifyWake(api, "owner/repo", "workflow_run", {
                workflow_run: { id: 1, run_attempt: 1 },
              });
    const candidates = [
      { number: 1, head: { sha: "c".repeat(40) }, updated_at: "2026-10-08T12:00:00Z" },
      { number: 2, head: { sha: head }, updated_at: "2026-10-07T12:00:00Z" },
    ];
    vi.spyOn(api, "pages").mockImplementation(async (path) =>
      path.endsWith("/pulls?state=open") ? candidates : [],
    );
    const reads: string[] = [];
    vi.spyOn(api, "request").mockImplementation(async (path, method, payload) => {
      reads.push(path);
      if (mode === "head-budget") {
        if (path.endsWith("/pulls/1"))
          return new Promise((_resolve, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => reject(new Error("unrelated budget spent")),
              { once: true },
            );
            queueMicrotask(() => controller.abort());
          });
        if (path.endsWith("/pulls/2"))
          return { head: { sha: head }, base: { sha: "b".repeat(40) } };
        if (method === "POST" && path.endsWith("/check-runs"))
          return { id: 91, ...(payload as object), app: { slug: "github-actions" } };
        if (method === "PATCH") return {};
        if (path === "/graphql")
          return {
            data: {
              repository: {
                pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
              },
            },
          };
      }
      throw new Error("ordinary candidate unavailable");
    });
    const trace = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(produceGates(api, policy, target)).rejects.toThrow(
        mode === "head-budget" ? "gate-reconciliation-timeout" : "gate-reconciliation-incomplete",
      );
      if (mode === "head-budget") {
        expect(reads[0]).toBe("/repos/owner/repo/pulls/2");
        expect(reads.at(-1)).toBe("/repos/owner/repo/pulls/1");
        expect(reads).toContain("/repos/owner/repo/check-runs/91");
        return;
      }
      expect(reads).toEqual([
        mode === "head" || mode === "direct"
          ? "/repos/owner/repo/pulls/2"
          : "/repos/owner/repo/pulls/1",
        mode === "head" || mode === "direct"
          ? "/repos/owner/repo/pulls/1"
          : "/repos/owner/repo/pulls/2",
      ]);
    } finally {
      trace.mockRestore();
    }
  },
);

test("actual producer entry owns one fifteen-minute signal across setup and reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spur-writer-entry-"));
  const eventPath = join(directory, "event.json");
  await writeFile(eventPath, "{}");
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const combined = vi.spyOn(AbortSignal, "any");
  const signals: AbortSignal[] = [];
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    signals.push(options?.signal as AbortSignal);
    const path = new URL(String(url)).pathname;
    return Response.json(
      path.endsWith("/ci.yml")
        ? { id: 1, path: ".github/workflows/ci.yml" }
        : path.endsWith("/pulls")
          ? []
          : { default_branch: "main" },
    );
  });
  const trace = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await runProducer({
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_TOKEN: "fixture",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_EVENT_PATH: eventPath,
      SPUR_CODE_REVIEW_ACTOR: "11",
      SPUR_BROWSER_REVIEW_ACTOR: "12",
    });
    expect(timeout.mock.calls.filter(([duration]) => duration === 15 * 60_000)).toHaveLength(1);
    expect(timeout.mock.calls.filter(([duration]) => duration === 30_000)).toHaveLength(
      signals.length,
    );
    expect(signals).toHaveLength(3);
    const budget = timeout.mock.results[0]?.value;
    expect(combined.mock.calls.every(([inputs]) => inputs[0] === budget)).toBe(true);
    expect(signals).toEqual(combined.mock.results.map((result) => result.value));
  } finally {
    timeout.mockRestore();
    combined.mockRestore();
    transport.mockRestore();
    trace.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["denied", "malformed", "merge-not-found"])(
  "candidate %s cannot abandon later head invalidation",
  async (fault) => {
    const api = new GateGitHub("fixture");
    const run = {
      id: 10,
      workflow_id: 1,
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      repository: { full_name: "owner/repo" },
      head_sha: "a".repeat(40),
      head_branch: "feature/example",
      display_title: `Spur CI v1 REF=refs/pull/1/merge M=${"c".repeat(40)}`,
      run_attempt: 1,
      run_started_at: "2026-10-05T12:00:00Z",
      status: "completed",
      conclusion: "success",
      pull_requests: [],
    };
    vi.spyOn(api, "pages").mockImplementation(async (path) =>
      path.endsWith("/pulls?state=open")
        ? [{ number: 1 }, { number: 2 }]
        : path.includes("/workflows/")
          ? [run]
          : [],
    );
    const writes: { path: string; payload: unknown }[] = [];
    vi.spyOn(api, "request").mockImplementation(async (path, method, payload) => {
      if (path === "/graphql")
        return {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        };
      if (method === "POST" || method === "PATCH") {
        writes.push({ path, payload });
        if (method === "POST")
          return { id: writes.length, ...(payload as object), app: { slug: "github-actions" } };
        return {};
      }
      if (path.endsWith("/pulls/1")) {
        if (fault === "denied") throw new Error("403");
        if (fault === "malformed") return { head: null };
      }
      if (path.endsWith("/pulls/1") || path.endsWith("/pulls/2"))
        return {
          head: { sha: "a".repeat(40) },
          base: { sha: "b".repeat(40) },
          ...(path.endsWith("/pulls/1") ? { merge_commit_sha: "c".repeat(40) } : {}),
        };
      if (path.includes("/commits/")) throw new Error("404");
      if (path.includes("/actions/runs/10")) return run;
      throw new Error("unexpected API");
    });
    const reconciliation = produceGates(api, {
      repository: "owner/repo",
      baseBranch: "main",
      codeActor: 11,
      browserActor: 12,
      ciWorkflowId: 1,
      ciJobs: ["Quality"],
    });
    if (fault === "merge-not-found") await reconciliation;
    else await expect(reconciliation).rejects.toThrow("gate-reconciliation-incomplete");
    expect(
      writes.some(({ payload }) =>
        (payload as { external_id?: string }).external_id?.startsWith("2:"),
      ),
    ).toBe(true);
    expect(writes.at(-1)?.payload).toMatchObject({ status: "completed", conclusion: "failure" });
  },
);

test.each(["pull_request_review", "pull_request"])(
  "validates readonly %s relay from authenticated run/workflow rather than name or PR association",
  async (event) => {
    const file = event === "pull_request_review" ? "review-wake.yml" : "ci.yml";
    const api = new GateGitHub("fixture", async (url) =>
      Response.json(
        String(url).includes("/runs/")
          ? {
              id: 1,
              repository: { full_name: "owner/repo" },
              event,
              workflow_id: 2,
              path: `.github/workflows/${file}@refs/pull/5/merge`,
              run_attempt: 1,
              head_sha: "a".repeat(40),
              pull_requests: [],
            }
          : { id: 2, path: `.github/workflows/${file}` },
      ),
    );
    await expect(
      verifyWake(api, "owner/repo", "workflow_run", {
        workflow_run: {
          id: 1,
          run_attempt: 1,
          conclusion: "success",
          pull_requests: [{ number: 999 }],
        },
      }),
    ).resolves.toEqual({ head: "a".repeat(40) });
  },
);
test.each(["repository", "workflow", "path", "attempt", "self"])(
  "rejects wrong authenticated upstream %s",
  async (fault) => {
    const api = new GateGitHub("fixture", async (url) =>
      Response.json(
        String(url).includes("/runs/")
          ? {
              id: 1,
              repository: { full_name: fault === "repository" ? "other/repo" : "owner/repo" },
              event: fault === "self" ? "workflow_run" : "pull_request_review",
              workflow_id: fault === "workflow" ? 3 : 2,
              path: fault === "path" ? "wrong" : ".github/workflows/review-wake.yml",
              run_attempt: fault === "attempt" ? 2 : 1,
            }
          : { id: 2, path: ".github/workflows/review-wake.yml" },
      ),
    );
    await expect(
      verifyWake(api, "owner/repo", "workflow_run", { workflow_run: { id: 1, run_attempt: 1 } }),
    ).rejects.toThrow();
  },
);
test("wake has no checkout/secrets; writer filters self and privileged PR execution", async () => {
  const wake = await readFile(
    new URL("../../../.github/workflows/review-wake.yml", import.meta.url),
    "utf8",
  );
  expect(wake).not.toMatch(/checkout|secrets\.|upload-artifact|download-artifact/);
  expect(
    (parse(wake) as { jobs: { wake: { steps: { run: string }[] } } }).jobs.wake.steps[0]?.run,
  ).toBe("true");
  const writer = parse(
    await readFile(
      new URL("../../../.github/workflows/review-approval.yml", import.meta.url),
      "utf8",
    ),
  ) as {
    on: { workflow_run: { workflows: string[] } };
    concurrency: { "cancel-in-progress": boolean };
    jobs: {
      approvals: {
        steps: {
          run?: string;
          "timeout-minutes"?: number;
          with?: { ref?: string; "persist-credentials"?: boolean };
        }[];
      };
    };
  };
  expect(writer.on.workflow_run.workflows).toEqual(["CI", "Spur Review Wake"]);
  expect(writer.jobs.approvals.steps[1]?.with?.["persist-credentials"]).toBe(false);
  expect(writer.jobs.approvals.steps[1]?.with?.ref).not.toContain("pull_request.head");
  expect(writer.concurrency["cancel-in-progress"]).toBe(false);
  expect(
    writer.jobs.approvals.steps.find(
      (step) => step.run === "node v2/dist/review-gate-producer.js",
    )?.["timeout-minutes"],
  ).toBe(20);
});
test("CI provenance uses built-in merge ref/SHA and all four default event checkouts", async () => {
  const ci = parse(
    await readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as {
    "run-name": string;
    jobs: Record<string, { steps: { uses?: string; with?: { ref?: string } }[] }>;
  };
  expect(ci["run-name"]).toMatch(
    /^Spur CI v1 REF=\$\{\{ github.ref \}\} M=\$\{\{ github.sha \}\}$/,
  );
  const checkouts = Object.values(ci.jobs).flatMap((job) =>
    job.steps.filter((step) => step.uses?.startsWith("actions/checkout@")),
  );
  expect(checkouts).toHaveLength(4);
  expect(checkouts.every((step) => step.with?.ref === undefined)).toBe(true);
});

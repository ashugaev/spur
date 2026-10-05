import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { expect, test, vi } from "vitest";
import { GateGitHub } from "../../src/review-gate.js";
import { produceGates, verifyWake } from "../../src/review-gate-producer.js";

test.each(["denied", "malformed", "snapshot-denied"])(
  "candidate %s cannot abandon later head invalidation",
  async (fault) => {
    const api = new GateGitHub("fixture");
    vi.spyOn(api, "pages").mockResolvedValue([{ number: 1 }, { number: 2 }]);
    const writes: { path: string; payload: unknown }[] = [];
    vi.spyOn(api, "request").mockImplementation(async (path, method, payload) => {
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
        return { head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } };
      throw new Error("snapshot 403");
    });
    await expect(
      produceGates(api, {
        repository: "owner/repo",
        baseBranch: "main",
        codeActor: 11,
        browserActor: 12,
        ciWorkflowId: 1,
        ciJobs: ["Quality"],
      }),
    ).rejects.toThrow("gate-reconciliation-incomplete");
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
    ).resolves.toBeUndefined();
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
    jobs: { approvals: { steps: { with?: { ref?: string; "persist-credentials"?: boolean } }[] } };
  };
  expect(writer.on.workflow_run.workflows).toEqual(["CI", "Spur Review Wake"]);
  expect(writer.jobs.approvals.steps[1]?.with?.["persist-credentials"]).toBe(false);
  expect(writer.jobs.approvals.steps[1]?.with?.ref).not.toContain("pull_request.head");
});

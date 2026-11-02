import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseSandboxConfig } from "../manual/release-protected-race.js";

const source = readFileSync(
  fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);
const workflow = parse(source) as {
  permissions: Record<string, string>;
  on: Record<string, unknown>;
  jobs: Record<
    string,
    {
      name: string;
      if?: string;
      needs?: string[];
      "runs-on": string;
      "timeout-minutes"?: number;
      steps: { run?: string; env?: Record<string, string> }[];
    }
  >;
};
const required = ["quality", "playwright", "runtime-integration", "real-agent-smoke"];
const gate = workflow.jobs["strict-success"];
if (!gate) throw new Error("Missing native strict gate");
const step = gate.steps[0];
if (!step?.run) throw new Error("Missing native assertion");
const script = step.run.split("node <<'NODE'\n")[1]?.split("\nNODE")[0];
if (!script) throw new Error("Missing assertion script");

function exitCode(results: Record<string, { result: string }>): number | null {
  if (!script) throw new Error("Missing assertion script");
  return spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, REQUIRED_RESULTS: JSON.stringify(results) },
  }).status;
}

describe("native same-run strict CI aggregate", () => {
  it("pins the four existing required jobs and an unconditional read-only native gate", () => {
    expect(gate.needs).toEqual(required);
    expect(gate.if).toBe("$" + "{{ always() }}");
    expect(gate["runs-on"]).toBe("ubuntu-latest");
    expect(gate["timeout-minutes"]).toBe(2);
    expect(gate.steps).toHaveLength(1);
    expect(Object.keys(step)).toEqual(["name", "env", "run"]);
    expect(step.env).toEqual({ REQUIRED_RESULTS: "$" + "{{ toJSON(needs) }}" });
    expect(workflow.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      actions: "read",
    });
    expect(workflow.on.pull_request).toEqual({
      branches: ["main", "feature/release-continuation"],
    });
    expect(
      Object.values(workflow.jobs).filter((job) => job.name === "Spur Strict CI"),
    ).toHaveLength(1);
  });

  it("accepts only exact successful executions", () => {
    expect(exitCode(Object.fromEntries(required.map((job) => [job, { result: "success" }])))).toBe(
      0,
    );
  });

  for (const result of ["failure", "skipped", "neutral", "cancelled", "pending", "unknown"]) {
    for (const job of required) {
      it(`rejects ${job} ${result}`, () => {
        expect(
          exitCode(
            Object.fromEntries(
              required.map((name) => [name, { result: name === job ? result : "success" }]),
            ),
          ),
        ).toBe(1);
      });
    }
  }

  it("rejects missing and extra needs rather than widening the required set", () => {
    expect(exitCode({})).toBe(1);
    const results = Object.fromEntries(required.map((job) => [job, { result: "success" }]));
    delete results.quality;
    expect(exitCode(results)).toBe(1);
    expect(exitCode({ ...results, optional: { result: "success" } })).toBe(1);
  });
});

describe("native proof sandbox boundary", () => {
  const names = [
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
  function input() {
    return {
      repository: "sandbox-owner/disposable-release-proof",
      disposable: true,
      sourceDigest: "a".repeat(64),
      workflowId: 1,
      approvalContext: "Spur Approval Gate",
      approvalAppId: 2,
      laneAppIds: [3, 4],
      laneAppSlugs: ["code-lane", "browser-lane"],
      cases: names.map((name, index) => ({
        name,
        pr: index + 1,
        head: "b".repeat(40),
        base: "c".repeat(40),
        mutations: [] as { path: string; method: string; body: Record<string, unknown> }[],
      })),
    };
  }
  it("accepts only an explicit complete disposable scenario plan", () => {
    expect(parseSandboxConfig(input()).cases).toHaveLength(13);
    expect(() => parseSandboxConfig({ ...input(), disposable: false })).toThrow();
    expect(() => parseSandboxConfig({ ...input(), repository: "ASHUGAEV/SPUR" })).toThrow();
    expect(() => parseSandboxConfig({ ...input(), laneAppIds: [3, 3] })).toThrow();
    expect(() => parseSandboxConfig({ ...input(), cases: input().cases.slice(1) })).toThrow();
  });
  it("rejects remote routes, forged checks, protection edits, force-push and credentials", () => {
    for (const mutation of [
      { path: "https://example.invalid", method: "POST", body: {} },
      { path: "check-runs", method: "POST", body: {} },
      { path: "rulesets/1", method: "PATCH", body: {} },
      { path: "git/refs/heads/main", method: "PATCH", body: { force: true } },
      { path: "actions/runs/1/rerun", method: "POST", body: { token: "redacted" } },
    ]) {
      const fixture = input();
      const row = fixture.cases[0];
      if (!row) throw new Error("Missing scenario fixture");
      row.mutations.push(mutation);
      expect(() => parseSandboxConfig(fixture)).toThrow();
    }
  });
});

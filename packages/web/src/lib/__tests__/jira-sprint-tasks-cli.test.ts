import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ChildProcessModule from "node:child_process";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>("node:child_process");
  const defaultExport =
    "default" in actual && typeof actual.default === "object" && actual.default !== null
      ? { ...(actual.default as Record<string, unknown>), execFile: execFileMock }
      : { execFile: execFileMock };

  return {
    ...actual,
    default: defaultExport,
    execFile: execFileMock,
  };
});

function queueExecFileSuccess(stdout: string): void {
  execFileMock.mockImplementationOnce(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout, stderr: "" });
      return {} as never;
    },
  );
}

function queueExecFileError(error: Error & { stderr?: string; stdout?: string }): void {
  execFileMock.mockImplementationOnce(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(error, { stdout: error.stdout ?? "", stderr: error.stderr ?? "" });
      return {} as never;
    },
  );
}

describe("jira-sprint-tasks CLI helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  it("returns empty array when jira CLI reports no results", async () => {
    queueExecFileError(
      Object.assign(new Error("Command failed"), {
        stderr: "\u001b[31mNo results found for given query\u001b[0m",
      }),
    );

    const { listJiraIssuesForJql } = await import("../jira-sprint-tasks");

    await expect(listJiraIssuesForJql("project = INT")).resolves.toEqual([]);
    expect(execFileMock).toHaveBeenCalledWith(
      "jira",
      ["issue", "list", "-q", "project = INT", "--raw"],
      expect.objectContaining({
        timeout: 30_000,
      }),
      expect.any(Function),
    );
  });

  it("returns empty array for malformed-but-valid non-array JSON payload", async () => {
    queueExecFileSuccess(JSON.stringify({ issues: [{ key: "INT-1" }] }));

    const { listJiraIssuesForJql } = await import("../jira-sprint-tasks");

    await expect(listJiraIssuesForJql("project = INT")).resolves.toEqual([]);
  });

  it("throws when jira CLI returns invalid JSON payload", async () => {
    queueExecFileSuccess('{"issues":[{"key":"INT-1"}');

    const { listJiraIssuesForJql } = await import("../jira-sprint-tasks");

    await expect(listJiraIssuesForJql("project = INT")).rejects.toBeInstanceOf(SyntaxError);
  });
});

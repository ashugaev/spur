import { describe, expect, it } from "vitest";
import { isGithubPrCheckUnavailablePayload } from "@/lib/types";

describe("isGithubPrCheckUnavailablePayload", () => {
  it("accepts a payload with a linked pull request", () => {
    expect(
      isGithubPrCheckUnavailablePayload({
        code: "github_pr_check_unavailable",
        sessionId: "api-1",
        rateLimited: true,
        pr: {
          number: 42,
          repo: "acme/api",
          url: "https://github.com/acme/api/pull/42",
        },
      }),
    ).toBe(true);
  });

  it("accepts a payload with a null pull request", () => {
    expect(
      isGithubPrCheckUnavailablePayload({
        code: "github_pr_check_unavailable",
        sessionId: "api-1",
        rateLimited: false,
        pr: null,
      }),
    ).toBe(true);
  });

  it("rejects a payload with the wrong code or missing fields", () => {
    expect(
      isGithubPrCheckUnavailablePayload({
        code: "open_pr_action_required",
        sessionId: "api-1",
        rateLimited: true,
        pr: null,
      }),
    ).toBe(false);
    expect(
      isGithubPrCheckUnavailablePayload({
        code: "github_pr_check_unavailable",
        sessionId: "api-1",
        pr: null,
      }),
    ).toBe(false);
    expect(
      isGithubPrCheckUnavailablePayload({
        code: "github_pr_check_unavailable",
        sessionId: "api-1",
        rateLimited: true,
        pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
      }),
    ).toBe(false);
  });
});

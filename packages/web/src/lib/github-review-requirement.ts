import {
  getGitHubRateLimitError,
  ghHeaders,
  handleGitHubRateLimit,
  type GitHubGraphQLError,
} from "@/lib/github-api";
import type { ReviewRequirement } from "@/lib/pr-status-shape";

export interface NativeReviewSource {
  reviewDecision?: unknown;
  headRefOid?: unknown;
  baseRefOid?: unknown;
  baseRefName?: unknown;
  baseRef?: unknown;
  reviewRequests?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

async function ownersAbsent(owner: string, repo: string, base: string): Promise<boolean> {
  if (getGitHubRateLimitError()) return false;
  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...ghHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        query: `query($owner:String!,$repo:String!,$github:String!,$root:String!,$docs:String!) {
          repository(owner:$owner,name:$repo) {
            github: object(expression:$github) { __typename }
            root: object(expression:$root) { __typename }
            docs: object(expression:$docs) { __typename }
          }
        }`,
        variables: {
          owner,
          repo,
          github: `${base}:.github/CODEOWNERS`,
          root: `${base}:CODEOWNERS`,
          docs: `${base}:docs/CODEOWNERS`,
        },
      }),
      cache: "no-store",
    });
    if (!response.ok) {
      handleGitHubRateLimit(response);
      return false;
    }
    const raw: unknown = await response.json();
    const payload = record(raw);
    const errors = payload?.["errors"];
    const rateLimitErrors: GitHubGraphQLError[] = Array.isArray(errors)
      ? errors.map((error) => {
          const entry = record(error);
          return {
            type: typeof entry?.["type"] === "string" ? entry["type"] : undefined,
            message: typeof entry?.["message"] === "string" ? entry["message"] : undefined,
          };
        })
      : [];
    handleGitHubRateLimit(response, rateLimitErrors);
    if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) return false;
    const repository = record(record(payload?.["data"])?.["repository"]);
    return (
      repository?.["github"] === null && repository["root"] === null && repository["docs"] === null
    );
  } catch {
    return false;
  }
}

export async function githubReviewRequirement(
  node: NativeReviewSource,
  blockingChanges: boolean | null,
  owner: string,
  repo: string,
  policyError = false,
): Promise<ReviewRequirement> {
  if (node.reviewDecision === "REVIEW_REQUIRED") return "required";
  if (policyError) return "unavailable";
  const base = node.baseRefOid;
  const head = node.headRefOid;
  const ref = record(node.baseRef);
  if (
    typeof base !== "string" ||
    !/^[0-9a-f]{40}$/i.test(base) ||
    typeof head !== "string" ||
    !/^[0-9a-f]{40}$/i.test(head) ||
    typeof node.baseRefName !== "string" ||
    node.baseRefName.length === 0 ||
    record(ref?.["target"])?.["oid"] !== base
  )
    return "unavailable";

  const rules = record(ref?.["rules"]);
  const nodes = rules?.["nodes"];
  if (!Array.isArray(nodes) || record(rules?.["pageInfo"])?.["hasNextPage"] !== false)
    return "unavailable";
  let requiresPr = false;
  let required = false;
  let owners = false;
  let conditional = false;
  for (const value of nodes) {
    const rule = record(value);
    if (typeof rule?.["type"] !== "string") return "unavailable";
    if (rule["type"] !== "PULL_REQUEST") continue;
    requiresPr = true;
    const parameters = record(rule["parameters"]);
    if (
      !count(parameters?.["requiredApprovingReviewCount"]) ||
      typeof parameters?.["requireCodeOwnerReview"] !== "boolean" ||
      typeof parameters?.["requireLastPushApproval"] !== "boolean"
    )
      return "unavailable";
    required ||=
      parameters["requiredApprovingReviewCount"] > 0 || parameters["requireLastPushApproval"];
    owners ||= parameters["requireCodeOwnerReview"];
    const reviewers = parameters["requiredReviewers"];
    if (reviewers !== null && !Array.isArray(reviewers)) return "unavailable";
    for (const value of reviewers ?? []) {
      const reviewer = record(value);
      const patterns = reviewer?.["filePatterns"];
      if (
        !count(reviewer?.["minimumApprovals"]) ||
        !Array.isArray(patterns) ||
        !patterns.every((pattern) => typeof pattern === "string")
      )
        return "unavailable";
      if (reviewer["minimumApprovals"] > 0) {
        if (patterns.length === 0) required = true;
        else conditional = true;
      }
    }
  }
  const classicValue = ref?.["branchProtectionRule"];
  if (classicValue !== null) {
    const classic = record(classicValue);
    if (
      typeof classic?.["requiresApprovingReviews"] !== "boolean" ||
      !count(classic?.["requiredApprovingReviewCount"]) ||
      typeof classic?.["requiresCodeOwnerReviews"] !== "boolean" ||
      typeof classic?.["requireLastPushApproval"] !== "boolean"
    )
      return "unavailable";
    requiresPr ||= classic["requiresApprovingReviews"];
    required ||= classic["requiredApprovingReviewCount"] > 0 || classic["requireLastPushApproval"];
    owners ||= classic["requiresCodeOwnerReviews"];
  }
  if (required) return "required";
  if (owners) {
    const requests = record(node.reviewRequests);
    const requestNodes = requests?.["nodes"];
    if (
      !Array.isArray(requestNodes) ||
      record(requests?.["pageInfo"])?.["hasNextPage"] !== false ||
      !requestNodes.every((request) => typeof record(request)?.["asCodeOwner"] === "boolean")
    )
      return "unavailable";
    if (requestNodes.some((request) => record(request)?.["asCodeOwner"] === true))
      return "required";
  }
  if (requiresPr && blockingChanges === true) return "required";
  if (conditional || (requiresPr && blockingChanges === null)) return "unavailable";
  if (owners && !(await ownersAbsent(owner, repo, base))) return "unavailable";
  return "none";
}

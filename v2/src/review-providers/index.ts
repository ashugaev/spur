import { parseRepoSlugFromRemoteUrl } from "../pr-lookup.js";
import type { ProjectConfig, ReviewProviderId } from "../types.js";
import { readRemoteUrls } from "../workspace.js";
import { githubReviewProvider } from "./github.js";
import { gitlabReviewProvider } from "./gitlab.js";
import type { ReviewProvider } from "./types.js";

const REVIEW_PROVIDERS = {
  github: githubReviewProvider,
  gitlab: gitlabReviewProvider,
} satisfies Record<ReviewProviderId, ReviewProvider>;

export function reviewProvider(providerId: ReviewProviderId): ReviewProvider {
  return REVIEW_PROVIDERS[providerId];
}

export function reviewProviders(): ReviewProvider[] {
  return Object.values(REVIEW_PROVIDERS);
}

function providerIdsFromProject(project?: Pick<ProjectConfig, "sources">): ReviewProviderId[] {
  if (!project) return [];
  const ids = new Set<ReviewProviderId>();
  for (const source of Object.values(project.sources)) {
    if (source.type === "github" || source.type === "gitlab") {
      ids.add(source.type);
    }
  }
  return [...ids];
}

function inferProviderFromRemotes(remotes: Map<string, string>): ReviewProviderId[] {
  const urls = [...remotes.values()];
  // Every remote is github.com: glab exits non-zero on such a repo ("none of
  // the git remotes ... point to a known GitLab host"), so no non-GitHub
  // provider can answer.
  if (
    urls.length > 0 &&
    urls.every((url) => parseRepoSlugFromRemoteUrl(url)?.host === "github.com")
  ) {
    return ["github"];
  }
  const origin = remotes.get("origin");
  if (!origin) {
    return ["github", "gitlab"];
  }
  return /\bgithub\b/i.test(origin) ? ["github", "gitlab"] : ["gitlab", "github"];
}

export async function orderedReviewProviderIds(
  worktreePath: string,
  project?: Pick<ProjectConfig, "sources">,
): Promise<ReviewProviderId[]> {
  const configured = providerIdsFromProject(project);
  if (configured.length > 0) {
    return configured;
  }
  return inferProviderFromRemotes(await readRemoteUrls(worktreePath));
}

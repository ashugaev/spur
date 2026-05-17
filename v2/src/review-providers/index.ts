import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig, ReviewProviderId } from "../types.js";
import { githubReviewProvider } from "./github.js";
import { gitlabReviewProvider } from "./gitlab.js";
import type { ReviewProvider } from "./types.js";

const execFileAsync = promisify(execFile);

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

async function readOriginRemoteUrl(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: worktreePath,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function inferProviderFromRemote(remoteUrl: string | null): ReviewProviderId[] {
  if (!remoteUrl) {
    return ["github", "gitlab"];
  }
  return /\bgithub\b/i.test(remoteUrl) ? ["github", "gitlab"] : ["gitlab", "github"];
}

export async function orderedReviewProviderIds(
  worktreePath: string,
  project?: Pick<ProjectConfig, "sources">,
): Promise<ReviewProviderId[]> {
  const configured = providerIdsFromProject(project);
  if (configured.length > 0) {
    return configured;
  }
  return inferProviderFromRemote(await readOriginRemoteUrl(worktreePath));
}

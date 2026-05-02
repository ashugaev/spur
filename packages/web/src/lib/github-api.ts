import { execFileSync } from "node:child_process";

let resolvedToken: string | null = null;
let tokenResolved = false;
let rateLimitResetAt = 0;

export function resetGitHubApiStateForTests(): void {
  resolvedToken = null;
  tokenResolved = false;
  rateLimitResetAt = 0;
}

export function resolveGhToken(): string | null {
  if (tokenResolved) return resolvedToken;

  tokenResolved = true;
  resolvedToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? null;
  if (resolvedToken) return resolvedToken;

  try {
    const output = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    resolvedToken = output.length > 0 ? output : null;
  } catch {
    resolvedToken = null;
  }

  return resolvedToken;
}

export function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  const token = resolveGhToken();
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export function handleGitHubRateLimit(response: Response): void {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const isRateLimited =
    response.status === 429 ||
    ((response.status === 403 || response.status === 401) && remaining === "0");
  if (!isRateLimited) return;

  const reset = response.headers.get("x-ratelimit-reset");
  const resetAt = reset ? Number(reset) * 1000 : Number.NaN;
  rateLimitResetAt = Number.isFinite(resetAt) ? resetAt : Date.now() + 60_000;
}

export function getGitHubRateLimitError(now = Date.now()): string | null {
  if (now >= rateLimitResetAt) return null;
  const wait = Math.ceil((rateLimitResetAt - now) / 1000);
  return `GitHub rate limit - retry in ${wait}s`;
}

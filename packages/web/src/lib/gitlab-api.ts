import { execFileSync } from "node:child_process";

const resolvedTokens = new Map<string, string | null>();

export function resetGitLabApiStateForTests(): void {
  resolvedTokens.clear();
}

export function resolveGlabToken(hostname = "gitlab.com"): string | null {
  if (resolvedTokens.has(hostname)) {
    return resolvedTokens.get(hostname) ?? null;
  }

  const envToken = process.env["GITLAB_TOKEN"] ?? process.env["GLAB_TOKEN"] ?? null;
  if (envToken) {
    resolvedTokens.set(hostname, envToken);
    return envToken;
  }

  try {
    const output = execFileSync("glab", ["config", "get", "--host", hostname, "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const token = output.trim();
    if (!token) {
      resolvedTokens.set(hostname, null);
      return null;
    }
    resolvedTokens.set(hostname, token);
    return token;
  } catch {
    resolvedTokens.set(hostname, null);
    return null;
  }
}

export function glabHeaders(hostname = "gitlab.com"): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = resolveGlabToken(hostname);
  if (token) {
    headers["private-token"] = token;
  }
  return headers;
}

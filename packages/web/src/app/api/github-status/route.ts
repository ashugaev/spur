import { NextResponse } from "next/server";
import {
  readGitHubStatusCache,
  writeGitHubStatusCache,
  type GitHubStatusResponse,
} from "@/lib/github-status";
import {
  getGitHubRateLimitError,
  ghHeaders,
  handleGitHubRateLimit,
  resolveGhToken,
} from "@/lib/github-api";

interface GitHubErrorBody {
  message?: string;
}

const CACHE_TTL_MS = 30_000;
const ERROR_CACHE_TTL_MS = 15_000;

function okResponse(requestedAt: string): GitHubStatusResponse {
  return { ok: true, requestedAt };
}

function errorResponse(error: string, requestedAt: string | null = null): GitHubStatusResponse {
  return { ok: false, error, requestedAt };
}

function isGitHubErrorBody(value: unknown): value is GitHubErrorBody {
  return typeof value === "object" && value !== null && "message" in value;
}

async function readGitHubMessage(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json();
    if (!isGitHubErrorBody(payload)) return null;
    if (typeof payload.message !== "string") return null;
    const message = payload.message.trim();
    return message.length > 0 ? message : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const cachedStatus = readGitHubStatusCache();
  if (cachedStatus && cachedStatus.expiresAt > Date.now()) {
    return NextResponse.json(cachedStatus.response);
  }

  const rateLimitError = getGitHubRateLimitError();
  if (rateLimitError) {
    const response = errorResponse(rateLimitError);
    writeGitHubStatusCache({ response, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
    return NextResponse.json(response);
  }

  if (!resolveGhToken()) {
    const response = errorResponse("GitHub auth unavailable");
    writeGitHubStatusCache({ response, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
    return NextResponse.json(response);
  }

  const requestedAt = new Date().toISOString();

  try {
    const response = await fetch("https://api.github.com/user", {
      method: "GET",
      headers: ghHeaders(),
      cache: "no-store",
    });

    if (!response.ok) {
      handleGitHubRateLimit(response);
      const message = await readGitHubMessage(response);
      const error =
        response.status === 401
          ? "GitHub auth failed"
          : (getGitHubRateLimitError() ??
            message ??
            (response.status === 403 ? "GitHub auth failed" : `GitHub API ${response.status}`));
      const payload = errorResponse(error, requestedAt);
      writeGitHubStatusCache({ response: payload, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
      return NextResponse.json(payload);
    }

    const payload = okResponse(requestedAt);
    writeGitHubStatusCache({ response: payload, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub API request failed";
    const payload = errorResponse(message, requestedAt);
    writeGitHubStatusCache({ response: payload, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
    return NextResponse.json(payload);
  }
}

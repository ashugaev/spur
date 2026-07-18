import { NextResponse } from "next/server";
import { glabHeaders, resolveGlabToken } from "@/lib/gitlab-api";
import {
  readGitLabStatusCache,
  writeGitLabStatusCache,
  type GitLabStatusResponse,
} from "@/lib/gitlab-status";

interface GitLabErrorBody {
  message?: string | string[];
  error?: string;
}

const CACHE_TTL_MS = 30_000;
const ERROR_CACHE_TTL_MS = 15_000;

function okResponse(requestedAt: string): GitLabStatusResponse {
  return { ok: true, requestedAt, configured: true };
}

function errorResponse(
  error: string,
  requestedAt: string | null,
  configured: boolean,
): GitLabStatusResponse {
  return { ok: false, error, requestedAt, configured };
}

function isGitLabErrorBody(value: unknown): value is GitLabErrorBody {
  return typeof value === "object" && value !== null;
}

async function readGitLabMessage(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json();
    if (!isGitLabErrorBody(payload)) return null;
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error.trim();
    }
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message.trim();
    }
    if (Array.isArray(payload.message)) {
      const message = payload.message.find(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      );
      return message?.trim() ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function GET() {
  const cachedStatus = readGitLabStatusCache();
  if (cachedStatus && cachedStatus.expiresAt > Date.now()) {
    return NextResponse.json(cachedStatus.response);
  }

  if (!resolveGlabToken()) {
    const response = errorResponse("GitLab auth unavailable", null, false);
    writeGitLabStatusCache({ response, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
    return NextResponse.json(response);
  }

  const requestedAt = new Date().toISOString();

  try {
    const response = await fetch("https://gitlab.com/api/v4/user", {
      method: "GET",
      headers: glabHeaders(),
      cache: "no-store",
    });

    if (!response.ok) {
      const message = await readGitLabMessage(response);
      const error =
        response.status === 401 || response.status === 403
          ? "GitLab auth failed"
          : (message ?? `GitLab API ${response.status}`);
      const payload = errorResponse(error, requestedAt, true);
      writeGitLabStatusCache({ response: payload, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
      return NextResponse.json(payload);
    }

    const payload = okResponse(requestedAt);
    writeGitLabStatusCache({ response: payload, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitLab API request failed";
    const payload = errorResponse(message, requestedAt, true);
    writeGitLabStatusCache({ response: payload, expiresAt: Date.now() + ERROR_CACHE_TTL_MS });
    return NextResponse.json(payload);
  }
}

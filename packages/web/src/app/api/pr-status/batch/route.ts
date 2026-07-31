import { type NextRequest, NextResponse } from "next/server";
import { getGitHubRateLimitError, ghHeaders, handleGitHubRateLimit } from "@/lib/github-api";
import {
  GITHUB_PR_STATUS_FIELDS,
  isGitHubPrNode,
  recordGitHubPrAbsent,
  recordGitHubPrError,
  recordGitHubPrNode,
} from "@/lib/github-pr-status";
import {
  type PrStatusResponse,
  cacheKeyForCoords,
  extractPrCoords,
  readCachedPrStatus,
} from "@/lib/pr-status-store";

const MAX_BATCH_URLS = 100;

interface AliasEntry {
  alias: string;
  key: string;
  owner: string;
  repo: string;
  number: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildAliasedQuery(entries: AliasEntry[]): {
  query: string;
  variables: Record<string, string | number>;
} {
  const varDecls: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, string | number> = {};
  for (const entry of entries) {
    const ownerVar = `owner_${entry.alias}`;
    const repoVar = `repo_${entry.alias}`;
    const numberVar = `number_${entry.alias}`;
    varDecls.push(`$${ownerVar}:String!`, `$${repoVar}:String!`, `$${numberVar}:Int!`);
    fields.push(
      `${entry.alias}: repository(owner:$${ownerVar},name:$${repoVar}) { pullRequest(number:$${numberVar}) { ${GITHUB_PR_STATUS_FIELDS} } }`,
    );
    variables[ownerVar] = entry.owner;
    variables[repoVar] = entry.repo;
    variables[numberVar] = Number(entry.number);
  }
  return { query: `query(${varDecls.join(",")}) {\n${fields.join("\n")}\n}`, variables };
}

// Maps each GraphQL error to the alias it belongs to via its `path` (GitHub
// includes the failing field's alias as the first path segment, e.g.
// `["pr1","pullRequest"]`). Errors without a resolvable alias are dropped
// here rather than applied to every miss — a caller with no matching entry
// falls back to `recordGitHubPrAbsent` instead of inheriting an unrelated
// alias's error message.
function gqlErrorsByAlias(errorsRaw: unknown): Map<string, string> {
  const byAlias = new Map<string, string>();
  if (!Array.isArray(errorsRaw)) return byAlias;
  for (const entry of errorsRaw) {
    if (!isRecord(entry)) continue;
    const message = typeof entry["message"] === "string" ? entry["message"].trim() : "";
    if (!message) continue;
    const path = entry["path"];
    const alias = Array.isArray(path) && typeof path[0] === "string" ? path[0] : null;
    if (!alias) continue;
    const existing = byAlias.get(alias);
    byAlias.set(alias, existing ? `${existing}; ${message}` : message);
  }
  return byAlias;
}

function recordForMisses(
  entries: AliasEntry[],
  missUrlsByKey: Map<string, string[]>,
  results: Record<string, PrStatusResponse>,
  message: string,
): void {
  for (const entry of entries) {
    const response = recordGitHubPrError(entry.key, message);
    for (const url of missUrlsByKey.get(entry.key) ?? []) results[url] = response;
  }
}

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  const urls = body["urls"];
  if (!Array.isArray(urls) || !urls.every((url): url is string => typeof url === "string")) {
    return NextResponse.json({ error: "urls must be an array of strings" }, { status: 400 });
  }
  if (urls.length > MAX_BATCH_URLS) {
    return NextResponse.json({ error: `at most ${MAX_BATCH_URLS} urls` }, { status: 400 });
  }

  const results: Record<string, PrStatusResponse> = {};
  const missUrlsByKey = new Map<string, string[]>();
  const missCoordsByKey = new Map<string, { owner: string; repo: string; number: string }>();

  for (const url of urls) {
    const coords = extractPrCoords(url);
    if (!coords) continue; // invalid URL: omitted from results, no 400

    const key = cacheKeyForCoords(coords);
    const cached = readCachedPrStatus(key);
    if (cached) {
      results[url] = cached;
      continue;
    }

    const list = missUrlsByKey.get(key);
    if (list) list.push(url);
    else missUrlsByKey.set(key, [url]);
    missCoordsByKey.set(key, coords);
  }

  if (missCoordsByKey.size === 0) {
    return NextResponse.json({ results });
  }

  const aliasEntries: AliasEntry[] = [...missCoordsByKey.entries()].map(([key, coords], index) => ({
    alias: `pr${index}`,
    key,
    ...coords,
  }));

  const rateLimitError = getGitHubRateLimitError();
  if (rateLimitError) {
    recordForMisses(aliasEntries, missUrlsByKey, results, rateLimitError);
    return NextResponse.json({ results });
  }

  try {
    const { query, variables } = buildAliasedQuery(aliasEntries);
    const ghResponse = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...ghHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });

    if (!ghResponse.ok) {
      handleGitHubRateLimit(ghResponse);
      recordForMisses(aliasEntries, missUrlsByKey, results, `GitHub API ${ghResponse.status}`);
      return NextResponse.json({ results });
    }

    const gqlRaw: unknown = await ghResponse.json().catch(() => null);
    const gqlData = isRecord(gqlRaw) && isRecord(gqlRaw["data"]) ? gqlRaw["data"] : {};
    const errorsByAlias = gqlErrorsByAlias(isRecord(gqlRaw) ? gqlRaw["errors"] : undefined);

    for (const entry of aliasEntries) {
      const aliasValue = gqlData[entry.alias];
      const node = isRecord(aliasValue) ? aliasValue["pullRequest"] : null;
      const aliasError = errorsByAlias.get(entry.alias);
      let response: PrStatusResponse;
      if (isGitHubPrNode(node)) {
        response = recordGitHubPrNode(entry.key, node, aliasError);
      } else if (aliasError) {
        response = recordGitHubPrError(entry.key, aliasError);
      } else {
        response = recordGitHubPrAbsent(entry.key);
      }
      for (const url of missUrlsByKey.get(entry.key) ?? []) results[url] = response;
    }

    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub API request failed";
    recordForMisses(aliasEntries, missUrlsByKey, results, message);
    return NextResponse.json({ results });
  }
}

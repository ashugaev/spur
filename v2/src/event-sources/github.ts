import { existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import { basename } from "node:path";
import { clearInterval, setInterval as startInterval } from "node:timers";
import { logSpurEvent } from "../event-log.js";
import { gh } from "../gh.js";
import {
  GITHUB_PR_LIFECYCLE_KINDS,
  GITHUB_WORK_ITEM_NEW_EVENT,
  type GitHubCheck,
  type GitHubPrSummary,
  type GitHubSourceConfig,
  type GitHubWorkItemEventData,
  type ReviewEventData,
  type ReviewSignal,
  type WorkItemScreenshotAttachment,
} from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";
import {
  clearGitHubMergeConflictRestoreReplay,
  deleteReviewSourceSnapshot,
  hasGitHubMergeConflictRestoreReplay,
  listSessions,
  readLifecycleBaselinedSessions,
  readReviewSourceSnapshots,
  readWorkItemRegistry,
  recordLifecycleBaselinedSession,
  recordWorkItem,
  removeLifecycleBaselinedSession,
  writeReviewSourceSnapshot,
} from "../metadata.js";
import { reviewProvider } from "../review-providers/index.js";
import { isRecord, parseJson, readNumber, readString } from "../review-providers/shared.js";

export {
  shortText,
  parseRepoFromUrl,
  normalizeReviewDecision,
  summarizeFailingCi,
  hasMergeConflict,
  resolvePrSummary,
  resolveTrackedBranch,
} from "../review-providers/github.js";

export type { GitHubCheck, GitHubPrSummary };

const LIFECYCLE_KINDS = new Set<string>(GITHUB_PR_LIFECYCLE_KINDS);
const WORK_ITEM_SCREENSHOT_LIMIT = 10;
const WORK_ITEM_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const WORK_ITEM_SCREENSHOT_TIMEOUT_MS = 10_000;
const RASTER_MIME_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);
const IMAGE_URL_RE =
  /!\[[^\]]*]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)|<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;

interface GitHubWorkItemSearchResult {
  number: number;
  title: string;
  url: string;
  repo: string;
  body: string;
}

function emitSignalsByKind(
  deps: SourceStartDeps<GitHubSourceConfig>,
  data: Omit<ReviewEventData, "signals">,
  signals: ReviewSignal[],
): void {
  const grouped = new Map<ReviewSignal["kind"], ReviewSignal[]>();
  for (const signal of signals) {
    const existing = grouped.get(signal.kind);
    if (existing) {
      existing.push(signal);
      continue;
    }
    grouped.set(signal.kind, [signal]);
  }

  for (const [kind, items] of grouped) {
    deps.emit<ReviewEventData>(`github:${kind}`, {
      ...data,
      signals: items,
    });
  }
}

function readWorkItemSearchResult(value: unknown): GitHubWorkItemSearchResult | null {
  if (!isRecord(value)) return null;
  const number = readNumber(value.number);
  const title = readString(value.title);
  const url = readString(value.url);
  const body = readString(value.body);
  const repository = isRecord(value.repository) ? value.repository : null;
  const repo = repository ? readString(repository.nameWithOwner) : null;
  if (number === null || title === null || url === null || repo === null) return null;
  return {
    number,
    title,
    url,
    repo,
    body: body ?? "",
  };
}

function isGitHubHostedUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "github.com" || host.endsWith(".githubusercontent.com");
}

function extractImageUrls(body: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(IMAGE_URL_RE)) {
    const rawUrl = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    if (!rawUrl) continue;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue;
    }
    if (!isGitHubHostedUrl(parsed)) continue;
    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
    if (urls.length >= WORK_ITEM_SCREENSHOT_LIMIT) break;
  }
  return urls;
}

function screenshotName(url: string, index: number, mimeType: string): string {
  const extension = RASTER_MIME_TYPES.get(mimeType) ?? "png";
  let name: string;
  try {
    name = basename(new URL(url).pathname);
  } catch {
    name = "";
  }
  if (!name || !name.includes(".")) {
    return `screenshot-${index + 1}.${extension}`;
  }
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function fetchScreenshot(
  url: string,
  index: number,
): Promise<WorkItemScreenshotAttachment | null> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    controller.abort();
  }, WORK_ITEM_SCREENSHOT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) return null;
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!mimeType || !RASTER_MIME_TYPES.has(mimeType)) return null;
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const size = Number(contentLength);
      if (!Number.isFinite(size) || size > WORK_ITEM_SCREENSHOT_MAX_BYTES) return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > WORK_ITEM_SCREENSHOT_MAX_BYTES) return null;
    return {
      url,
      name: screenshotName(url, index, mimeType),
      mimeType,
      size: buffer.length,
      data: buffer.toString("base64"),
    };
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function collectWorkItemScreenshots(body: string): Promise<WorkItemScreenshotAttachment[]> {
  const screenshots: WorkItemScreenshotAttachment[] = [];
  for (const url of extractImageUrls(body)) {
    const screenshot = await fetchScreenshot(url, screenshots.length);
    if (screenshot) {
      screenshots.push(screenshot);
    }
  }
  return screenshots;
}

async function pollWorkItems(
  deps: SourceStartDeps<GitHubSourceConfig>,
  query: string,
  seenWorkItems: Set<string>,
) {
  const raw = await gh(
    process.cwd(),
    "search",
    "prs",
    query,
    "--state",
    "open",
    "--json",
    "number,title,url,repository,body",
    "--limit",
    "100",
  );
  const parsed = parseJson(raw);
  const items = Array.isArray(parsed)
    ? parsed.map(readWorkItemSearchResult).filter((item) => item !== null)
    : [];
  // Snapshot the repos that already have at least one seen entry before this poll
  // mutates the set. A returned item whose repo is absent here belongs to a fresh
  // backlog (first poll for that repo, e.g. post-rename or fresh install): record
  // it as seen but suppress the emit to avoid a one-time burst of spawns.
  const reposWithSeenEntries = new Set([...seenWorkItems].map((id) => id.split("#")[0]));
  for (const item of items) {
    const repo = item.repo;
    const externalId = `${repo}#${item.number}`;
    if (seenWorkItems.has(externalId)) continue;
    if (!reposWithSeenEntries.has(repo)) {
      recordWorkItem(deps.dataDir, deps.projectId, deps.sourceId, externalId);
      seenWorkItems.add(externalId);
      continue;
    }
    const eventData: GitHubWorkItemEventData = {
      externalId,
      url: item.url,
      number: item.number,
      title: item.title,
      repo,
      body: item.body,
      screenshots: await collectWorkItemScreenshots(item.body),
    };
    recordWorkItem(deps.dataDir, deps.projectId, deps.sourceId, externalId);
    seenWorkItems.add(externalId);
    deps.emit(GITHUB_WORK_ITEM_NEW_EVENT, eventData);
  }
}

async function startGitHubSource(deps: SourceStartDeps<GitHubSourceConfig>): Promise<SourceHandle> {
  const provider = reviewProvider("github");
  const snapshots = readReviewSourceSnapshots(
    deps.dataDir,
    "github",
    deps.projectId,
    deps.sourceId,
  );
  const seenWorkItems = deps.config.query
    ? readWorkItemRegistry(deps.dataDir, deps.projectId, deps.sourceId)
    : null;
  const lifecycleBaselined = readLifecycleBaselinedSessions(
    deps.dataDir,
    deps.projectId,
    deps.sourceId,
  );
  let stopped = false;
  let polling = false;
  let pollingWorkItems = false;

  const pollSignals = async (emitInitial: boolean): Promise<void> => {
    if (stopped || deps.signal.aborted || polling) return;
    polling = true;
    try {
      const sessions = listSessions(deps.dataDir).filter(
        (session) =>
          session.project === deps.projectId &&
          session.status === "running" &&
          Boolean(session.worktreePath) &&
          existsSync(session.worktreePath),
      );
      const currentSessionIds = new Set<string>();

      for (const session of sessions) {
        currentSessionIds.add(session.id);
        try {
          const restoreReplayRequested = hasGitHubMergeConflictRestoreReplay(
            deps.dataDir,
            deps.projectId,
            deps.sourceId,
            session.id,
          );
          const collected = await provider.collectSignals(
            session,
            deps.dataDir,
            deps.projectId,
            deps.sourceId,
          );
          if (!collected) {
            snapshots.delete(session.id);
            deleteReviewSourceSnapshot(
              deps.dataDir,
              "github",
              deps.projectId,
              deps.sourceId,
              session.id,
            );
            if (restoreReplayRequested) {
              clearGitHubMergeConflictRestoreReplay(
                deps.dataDir,
                deps.projectId,
                deps.sourceId,
                session.id,
              );
            }
            continue;
          }

          const previous = snapshots.get(session.id);
          const next = collected.snapshot;
          const changed = [...next.values()].filter((signal) => {
            const prior = previous?.get(signal.key);
            return !prior || prior.text !== signal.text;
          });

          snapshots.set(session.id, next);
          writeReviewSourceSnapshot(
            deps.dataDir,
            "github",
            deps.projectId,
            deps.sourceId,
            session.id,
            next,
          );

          if (restoreReplayRequested) {
            const mergeConflictSignal = next.get("merge_conflict");
            if (mergeConflictSignal) {
              emitSignalsByKind(deps, collected.data, [mergeConflictSignal]);
            }
            clearGitHubMergeConflictRestoreReplay(
              deps.dataDir,
              deps.projectId,
              deps.sourceId,
              session.id,
            );
            continue;
          }

          const baselined = lifecycleBaselined.has(session.id);
          if (!baselined) {
            recordLifecycleBaselinedSession(
              deps.dataDir,
              deps.projectId,
              deps.sourceId,
              session.id,
            );
            lifecycleBaselined.add(session.id);
          }
          const candidates = previous ? changed : emitInitial ? [...next.values()] : [];
          const toEmit = baselined
            ? candidates
            : candidates.filter((signal) => !LIFECYCLE_KINDS.has(signal.kind));
          if (toEmit.length > 0) {
            emitSignalsByKind(deps, collected.data, toEmit);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.logger.warn?.(
            `[source:${deps.projectId}/${deps.sourceId}] failed to poll ${session.id}: ${message}`,
          );
          logSpurEvent(deps.dataDir, {
            event: "source.poll.error",
            level: "error",
            projectId: deps.projectId,
            sourceId: deps.sourceId,
            sessionId: session.id,
            message: `Signal poll failed for ${deps.projectId}/${deps.sourceId}/${session.id}: ${message}`,
          });
        }
      }

      for (const sessionId of [...snapshots.keys()]) {
        if (!currentSessionIds.has(sessionId)) {
          snapshots.delete(sessionId);
          deleteReviewSourceSnapshot(
            deps.dataDir,
            "github",
            deps.projectId,
            deps.sourceId,
            sessionId,
          );
          clearGitHubMergeConflictRestoreReplay(
            deps.dataDir,
            deps.projectId,
            deps.sourceId,
            sessionId,
          );
          removeLifecycleBaselinedSession(deps.dataDir, deps.projectId, deps.sourceId, sessionId);
          lifecycleBaselined.delete(sessionId);
        }
      }
    } finally {
      polling = false;
    }
  };

  const syncWorkItems = async (): Promise<void> => {
    if (
      !deps.config.query ||
      !seenWorkItems ||
      stopped ||
      deps.signal.aborted ||
      pollingWorkItems
    ) {
      return;
    }
    pollingWorkItems = true;
    try {
      await pollWorkItems(deps, deps.config.query, seenWorkItems);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] work-item poll failed: ${message}`,
      );
      logSpurEvent(deps.dataDir, {
        event: "source.work_item_poll.error",
        level: "error",
        projectId: deps.projectId,
        sourceId: deps.sourceId,
        message: `Work-item poll failed for ${deps.projectId}/${deps.sourceId}: ${message}`,
      });
    } finally {
      pollingWorkItems = false;
    }
  };

  const timer = startInterval(() => {
    void pollSignals(false);
    void syncWorkItems();
  }, deps.config.intervalMs);

  if (!deps.config.runOnStart) {
    if (deps.deferInitialSync) {
      void pollSignals(false);
      void syncWorkItems();
    } else {
      await pollSignals(false);
      await syncWorkItems();
    }
  }

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    ...(deps.config.runOnStart
      ? {
          runOnStart(): void {
            void pollSignals(true);
            void syncWorkItems();
          },
        }
      : {}),
  };
}

export const githubSourceModule: SourceModule<GitHubSourceConfig> = {
  type: "github",
  start: startGitHubSource,
};

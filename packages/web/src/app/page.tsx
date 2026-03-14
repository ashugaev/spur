import type { Metadata } from "next";
import { Suspense } from "react";
import { Dashboard, type DashboardProjectFilterOption } from "@/components/Dashboard";
import type { DashboardSession, IntegrationsStatusSnapshot } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
} from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";
import { readIntegrationsStatusSnapshot, fallbackIntegrationsStatus } from "@/lib/integration-status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "ao | Dashboard" },
};

interface HomePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function readSearchParamValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

export default async function Home({ searchParams }: HomePageProps) {
  let sessions: DashboardSession[] = [];
  let initialIntegrationsStatus: IntegrationsStatusSnapshot = fallbackIntegrationsStatus();
  const projectFilters: DashboardProjectFilterOption[] = [];
  const orchestratorByProject: Record<string, string> = {};
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const initialProjectId = readSearchParamValue(resolvedSearchParams?.projectId);

  try {
    initialIntegrationsStatus = readIntegrationsStatusSnapshot();
  } catch {
    // Keep fallback status if snapshot cannot be read.
  }

  try {
    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    for (const [id, project] of Object.entries(config.projects)) {
      const listeners = (project as { listeners?: Record<string, unknown> }).listeners;
      const hasTracker = Boolean(project.tracker?.plugin && listeners && Object.keys(listeners).length > 0);
      const hasCronListener = Object.values(
        (project as { listeners?: Record<string, { source?: unknown }> }).listeners ?? {},
      ).some((l) => l.source === "cron");
      const hasCronTrigger = Object.values(
        (project as { triggers?: Record<string, { event?: unknown }> }).triggers ?? {},
      ).some((t) => t.event === "cron:tick");
      const hasCron = hasCronListener || hasCronTrigger;
      projectFilters.push({ id, label: project.name || id, hasTracker, hasCron });
    }

    for (const session of allSessions) {
      if (session.id.endsWith("-orchestrator")) {
        orchestratorByProject[session.projectId] = session.id;
      }
    }

    const coreSessions = allSessions.filter((session) => !session.id.endsWith("-orchestrator"));
    sessions = coreSessions.map(sessionToDashboard);

    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([enrichSessionsMetadata(coreSessions, sessions, config, registry), metaTimeout]);

    const terminalStatuses = new Set(["merged", "killed", "cleanup", "done", "terminated"]);
    const enrichPromises = coreSessions.map((core, index) => {
      if (!core.pr) return Promise.resolve();

      const cacheKey = prCacheKey(core.pr.owner, core.pr.repo, core.pr.number);
      const cached = prCache.get(cacheKey);

      if (cached && sessions[index].pr) {
        sessions[index].pr.state = cached.state;
        sessions[index].pr.title = cached.title;
        sessions[index].pr.additions = cached.additions;
        sessions[index].pr.deletions = cached.deletions;
        sessions[index].pr.ciStatus = cached.ciStatus as "none" | "pending" | "passing" | "failing";
        sessions[index].pr.reviewDecision = cached.reviewDecision as
          | "none"
          | "pending"
          | "approved"
          | "changes_requested";
        sessions[index].pr.ciChecks = cached.ciChecks.map((check) => ({
          name: check.name,
          status: check.status as "pending" | "running" | "passed" | "failed" | "skipped",
          url: check.url,
        }));
        sessions[index].pr.mergeability = cached.mergeability;
        sessions[index].pr.unresolvedThreads = cached.unresolvedThreads;
        sessions[index].pr.unresolvedComments = cached.unresolvedComments;

        if (
          terminalStatuses.has(core.status) ||
          cached.state === "merged" ||
          cached.state === "closed"
        ) {
          return Promise.resolve();
        }
      }

      const project = resolveProject(core, config.projects);
      const scm = getSCM(registry, project);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(sessions[index], scm, core.pr);
    });

    const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);
  } catch {
    // Config not found or services unavailable — show empty dashboard.
  }

  return (
    <Suspense>
      <Dashboard
        initialSessions={sessions}
        initialIntegrationsStatus={initialIntegrationsStatus}
        initialProjectId={initialProjectId}
        projectFilters={projectFilters}
        orchestratorByProject={orchestratorByProject}
      />
    </Suspense>
  );
}

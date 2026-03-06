"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  type IntegrationStatusEntry,
  type IntegrationsStatusSnapshot,
  getAttentionLevel,
  isPRRateLimited,
  INTEGRATION_STATUS_KEYS,
  INTEGRATION_STATUS_LABELS,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";

interface DashboardProps {
  initialSessions: DashboardSession[];
  initialIntegrationsStatus: IntegrationsStatusSnapshot;
  stats: DashboardStats;
  orchestratorId?: string | null;
  projectName?: string;
}

const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;

export function Dashboard({
  initialSessions,
  initialIntegrationsStatus,
  stats,
  orchestratorId,
  projectName,
}: DashboardProps) {
  const sessions = useSessionEvents(initialSessions);
  const [integrationsStatus, setIntegrationsStatus] = useState(initialIntegrationsStatus);
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of sessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return sessions
      .filter((s): s is DashboardSession & { pr: DashboardPR } => s.pr?.state === "open")
      .map((s) => s.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to kill ${sessionId}:`, await res.text());
    }
  };

  const handleMerge = async (prNumber: number) => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      console.error(`Failed to merge PR #${prNumber}:`, await res.text());
    }
  };

  const handleRestore = async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to restore ${sessionId}:`, await res.text());
    }
  };

  const hasKanbanSessions = KANBAN_LEVELS.some((l) => grouped[l].length > 0);

  const anyRateLimited = useMemo(
    () => sessions.some((s) => s.pr && isPRRateLimited(s.pr)),
    [sessions],
  );

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const response = await fetch("/api/integrations/status", { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as IntegrationsStatusSnapshot;
        if (!cancelled) {
          setIntegrationsStatus(next);
        }
      } catch {
        // Keep the last known status
      }
    };

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="px-8 py-7">
      <DynamicFavicon sessions={sessions} projectName={projectName} />
      {/* Header */}
      <div className="mb-8 flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-6">
        <div className="flex items-center gap-6">
          <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)]">
            Orchestrator
          </h1>
          <StatusLine stats={stats} />
        </div>
        {orchestratorId && (
          <a
            href={`/sessions/${encodeURIComponent(orchestratorId)}`}
            className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
            orchestrator
            <svg className="h-3 w-3 opacity-70" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        )}
      </div>

      {/* Rate limit notice */}
      {anyRateLimited && !rateLimitDismissed && (
        <div className="mb-6 flex items-center gap-2.5 rounded border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="flex-1">
            GitHub API rate limited — PR data (CI status, review state, sizes) may be stale.
            {" "}Will retry automatically on next refresh.
          </span>
          <button
            onClick={() => setRateLimitDismissed(true)}
            className="ml-1 shrink-0 opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <IntegrationStatusPanel status={integrationsStatus} />

      {/* Kanban columns for active zones */}
      {hasKanbanSessions && (
        <div className="mb-8 flex gap-4 overflow-x-auto pb-2">
          {KANBAN_LEVELS.map((level) =>
            grouped[level].length > 0 ? (
              <div key={level} className="min-w-[200px] flex-1">
                <AttentionZone
                  level={level}
                  sessions={grouped[level]}
                  variant="column"
                  onSend={handleSend}
                  onKill={handleKill}
                  onMerge={handleMerge}
                  onRestore={handleRestore}
                />
              </div>
            ) : null,
          )}
        </div>
      )}

      {/* Done — full-width grid below Kanban */}
      {grouped.done.length > 0 && (
        <div className="mb-8">
          <AttentionZone
            level="done"
            sessions={grouped.done}
            variant="grid"
            onSend={handleSend}
            onKill={handleKill}
            onMerge={handleMerge}
            onRestore={handleRestore}
          />
        </div>
      )}

      {/* PR Table */}
      {openPRs.length > 0 && (
        <div className="mx-auto max-w-[900px]">
          <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Pull Requests
          </h2>
          <div className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)]">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border-muted)]">
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    PR
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Title
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Size
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    CI
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Review
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Unresolved
                  </th>
                </tr>
              </thead>
              <tbody>
                {openPRs.map((pr) => (
                  <PRTableRow key={pr.number} pr={pr} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function IntegrationStatusPanel({ status }: { status: IntegrationsStatusSnapshot }) {
  const updatedLabel =
    status.updatedAt && status.source === "snapshot"
      ? `updated ${formatStatusTimestamp(status.updatedAt)}`
      : "snapshot unavailable";
  const entries = INTEGRATION_STATUS_KEYS.map((key) => ({
    key,
    label: INTEGRATION_STATUS_LABELS[key],
    entry: status.integrations[key],
  }));
  const summary = entries.reduce(
    (counts, item) => {
      counts[integrationTone(item.entry)] += 1;
      return counts;
    },
    { healthy: 0, attention: 0, inactive: 0, error: 0 } as Record<IntegrationTone, number>,
  );
  const attentionCount = summary.attention + summary.error;

  return (
    <section className="mb-7 rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4 md:p-5">
      <div className="mb-4 border-b border-[var(--color-border-subtle)] pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-secondary)]">
              Integrations
            </h2>
            <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
              Listener runtime and connection health.
            </p>
          </div>
          <span className="text-[11px] text-[var(--color-text-secondary)]">
            {updatedLabel}
            {" · "}
            {status.source}
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <SummaryPill label="ok" value={summary.healthy} tone="healthy" />
          <SummaryPill
            label="attention"
            value={attentionCount}
            tone={attentionCount > 0 ? "attention" : "inactive"}
          />
          <SummaryPill label="inactive" value={summary.inactive} tone="inactive" />
        </div>
        <p className="sr-only">
          {summary.healthy} integrations healthy, {attentionCount} need attention, {summary.inactive} inactive.
        </p>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2 md:grid-cols-3">
        {entries.map(({ key, label, entry }) => {
          const tone = integrationTone(entry);
          return (
            <article
              key={key}
              className={integrationCardClass(tone)}
              aria-label={`${label}: ${formatStateLabel(entry.state)}`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={integrationDotClass(tone)} aria-hidden="true" />
                  <h3 className="text-[12px] font-medium text-[var(--color-text-primary)]">
                    {label}
                  </h3>
                </div>
                <span className={stateBadgeClass(entry)}>{formatStateLabel(entry.state)}</span>
              </div>
              <div className="grid gap-1.5">
                <BooleanPill label="active" value={entry.active} />
                <BooleanPill label="connected" value={entry.connected} />
                <BooleanPill label="ok" value={entry.ok} />
              </div>
              {entry.message && (
                <p className="mt-2.5 rounded-[5px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-2 py-1.5 text-[11px] leading-[1.35] text-[var(--color-text-secondary)]">
                  {entry.message}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function BooleanPill({ label, value }: { label: string; value: boolean }) {
  return (
    <div
      className={
        value
          ? "flex items-center justify-between rounded-[5px] border border-[rgba(63,185,80,0.45)] bg-[rgba(63,185,80,0.12)] px-2 py-1 text-[11px] text-[var(--color-status-ready)]"
          : "flex items-center justify-between rounded-[5px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]"
      }
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className={
            value
              ? "h-1.5 w-1.5 rounded-full bg-[var(--color-status-ready)]"
              : "h-1.5 w-1.5 rounded-full bg-[var(--color-border-strong)]"
          }
          aria-hidden="true"
        />
        <span className="text-[10px] uppercase tracking-[0.07em]">{label}</span>
      </span>
      <span className="text-[11px] font-semibold tracking-[0.02em]">
        {value ? "Yes" : "No"}
      </span>
    </div>
  );
}

type IntegrationTone = "healthy" | "attention" | "inactive" | "error";

function integrationTone(entry: IntegrationStatusEntry): IntegrationTone {
  if (entry.ok) return "healthy";
  if (!entry.active) return "inactive";
  if (entry.connected) return "attention";
  return "error";
}

function integrationCardClass(tone: IntegrationTone): string {
  const base =
    "rounded-[7px] border bg-[linear-gradient(175deg,rgba(28,33,40,0.95)_0%,rgba(18,23,30,0.95)_100%)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
  if (tone === "healthy") return `${base} border-[rgba(63,185,80,0.35)]`;
  if (tone === "attention") return `${base} border-[rgba(210,153,34,0.35)]`;
  if (tone === "error") return `${base} border-[rgba(248,81,73,0.45)]`;
  return `${base} border-[var(--color-border-subtle)]`;
}

function integrationDotClass(tone: IntegrationTone): string {
  if (tone === "healthy") return "h-2 w-2 rounded-full bg-[var(--color-status-ready)]";
  if (tone === "attention") return "h-2 w-2 rounded-full bg-[var(--color-status-attention)]";
  if (tone === "error") return "h-2 w-2 rounded-full bg-[var(--color-status-error)]";
  return "h-2 w-2 rounded-full bg-[var(--color-border-strong)]";
}

function toneBadgeClass(tone: IntegrationTone): string {
  if (tone === "healthy") {
    return "border-[rgba(63,185,80,0.45)] bg-[rgba(63,185,80,0.14)] text-[var(--color-status-ready)]";
  }
  if (tone === "attention") {
    return "border-[rgba(210,153,34,0.45)] bg-[rgba(210,153,34,0.14)] text-[var(--color-status-attention)]";
  }
  if (tone === "error") {
    return "border-[rgba(248,81,73,0.45)] bg-[rgba(248,81,73,0.14)] text-[var(--color-status-error)]";
  }
  return "border-[var(--color-border-default)] bg-[var(--color-bg-surface)] text-[var(--color-text-secondary)]";
}

function SummaryPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: IntegrationTone;
}) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]",
        toneBadgeClass(tone),
      ].join(" ")}
    >
      <span className="tabular-nums">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function stateBadgeClass(entry: IntegrationStatusEntry): string {
  return [
    "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]",
    toneBadgeClass(integrationTone(entry)),
  ].join(" ");
}

function formatStateLabel(value: string): string {
  const normalized = value.replace(/[_-]+/g, " ").trim();
  if (!normalized) {
    return "Unknown";
  }
  return normalized
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatStatusTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${date.toISOString().slice(11, 19)}Z`;
}

function StatusLine({ stats }: { stats: DashboardStats }) {
  if (stats.totalSessions === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no sessions</span>;
  }

  const parts: Array<{ value: number; label: string; color?: string }> = [
    { value: stats.totalSessions, label: "sessions" },
    ...(stats.workingSessions > 0
      ? [{ value: stats.workingSessions, label: "working", color: "var(--color-status-working)" }]
      : []),
    ...(stats.openPRs > 0 ? [{ value: stats.openPRs, label: "PRs" }] : []),
    ...(stats.needsReview > 0
      ? [{ value: stats.needsReview, label: "need review", color: "var(--color-status-attention)" }]
      : []),
  ];

  return (
    <div className="flex items-baseline gap-0.5">
      {parts.map((p, i) => (
        <span key={p.label} className="flex items-baseline">
          {i > 0 && (
            <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">·</span>
          )}
          <span
            className="text-[20px] font-bold tabular-nums tracking-tight"
            style={{ color: p.color ?? "var(--color-text-primary)" }}
          >
            {p.value}
          </span>
          <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">
            {p.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function mergeScore(
  pr: Pick<DashboardPR, "ciStatus" | "reviewDecision" | "mergeability" | "unresolvedThreads">,
): number {
  let score = 0;
  if (!pr.mergeability.noConflicts) score += 40;
  if (pr.ciStatus === CI_STATUS.FAILING) score += 30;
  else if (pr.ciStatus === CI_STATUS.PENDING) score += 5;
  if (pr.reviewDecision === "changes_requested") score += 20;
  else if (pr.reviewDecision !== "approved") score += 10;
  score += pr.unresolvedThreads * 5;
  return score;
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CenteredLoader } from "@/components/CenteredLoader";
import { buildCronRows, fetchCronJobs, type CronRow, type CronRun } from "@/lib/cron-jobs";
import { formatAbsoluteTime, formatRelativeTime, formatShortTimestamp } from "@/lib/format";
import { buildSessionPath } from "@/lib/project-routes";
import type {
  CronActionEvent,
  CronJobsResponse,
  CronProjectView,
  CronSpawnBlockView,
  ProjectInfo,
} from "@/lib/types";

type LoadState =
  | { status: "pending" }
  | { status: "error" }
  | { status: "ready"; data: CronJobsResponse };

const LABEL_CLASS = "text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]";
const SECTION_HEADING_CLASS =
  "text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-secondary)]";
const SECTION_CLASS = "flex flex-col gap-2 border-t border-[var(--color-border-subtle)] pt-3";
const GRID_CLASS =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 sm:grid-cols-[minmax(0,1fr)_9.5rem_5.5rem_minmax(0,1fr)]";
const PRIMARY_TEXT = "text-[var(--color-text-primary)]";
const SECONDARY_TEXT = "text-[var(--color-text-secondary)]";
const ERROR_TEXT = "text-[var(--color-status-error)]";
const ATTENTION_TEXT = "text-[var(--color-status-attention)]";

const DISK_MARKER_TITLE: Partial<Record<CronRow["disk"], string>> = {
  changed: "changed on disk",
  added: "added on disk, not loaded",
  removed: "removed on disk",
};

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function noTickText(eventsSince: string | null): string {
  return eventsSince ? `No tick since ${formatAbsoluteTime(eventsSince)}` : "No tick recorded";
}

function driftLine(project: CronProjectView, allProjects: boolean): ReactNode {
  const prefix = allProjects ? `${project.projectName}: ` : "";
  const { owner } = project;
  if (owner.state === "loaded") {
    if (!owner.changed) return null;
    return (
      <span className={ATTENTION_TEXT}>
        • {prefix}
        {fileName(owner.path)} changed on disk, not loaded
      </span>
    );
  }
  if (owner.state === "invalid") {
    return (
      <span className={ERROR_TEXT}>
        • {prefix}
        {fileName(owner.path)} invalid: {owner.error}
      </span>
    );
  }
  return <span className={ATTENTION_TEXT}>• config file not found for {project.projectName}</span>;
}

function SessionLink({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return (
    <Link
      className={`${PRIMARY_TEXT} underline-offset-2 hover:underline`}
      href={buildSessionPath(sessionId, projectId)}
      onClick={(event) => event.stopPropagation()}
    >
      {sessionId}
    </Link>
  );
}

function ActionCell({ row }: { row: CronRow }) {
  if (!row.trigger)
    return <span className={`truncate ${SECONDARY_TEXT}`}>No action configured</span>;
  const action = row.lastAction;
  if (!action) return <span className={SECONDARY_TEXT}>—</span>;
  switch (action.event) {
    case "trigger.spawn.completed":
      return action.sessionId ? (
        <SessionLink projectId={row.projectId} sessionId={action.sessionId} />
      ) : (
        <span className={PRIMARY_TEXT}>Launched</span>
      );
    case "trigger.spawn.failed":
      return <span className={`truncate ${ERROR_TEXT}`}>Launch failed</span>;
    case "trigger.send.ignored":
      return <span className={SECONDARY_TEXT}>Ignored</span>;
    case "trigger.spawn.suppressed":
      return <span className={SECONDARY_TEXT}>Suppressed</span>;
  }
}

function RunText({ action, projectId }: { action: CronActionEvent; projectId: string }) {
  switch (action.event) {
    case "trigger.spawn.completed":
      return action.sessionId ? (
        <span className={PRIMARY_TEXT}>
          Session <SessionLink projectId={projectId} sessionId={action.sessionId} />
        </span>
      ) : (
        <span className={PRIMARY_TEXT}>Launched</span>
      );
    case "trigger.spawn.failed":
      return <span className={ERROR_TEXT}>Launch failed: {action.message ?? "unknown error"}</span>;
    case "trigger.send.ignored":
      return <span className={PRIMARY_TEXT}>Ignored</span>;
    case "trigger.spawn.suppressed":
      return <span className={PRIMARY_TEXT}>Suppressed</span>;
  }
}

function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={SECONDARY_TEXT}>{label}</dt>
      <dd className={`min-w-0 ${PRIMARY_TEXT}`}>{children}</dd>
    </>
  );
}

function actionSummary(row: CronRow): string {
  if (!row.trigger) return "No action configured";
  if (row.trigger.action.kind === "send") return "send";
  const count = row.trigger.action.blocks.length;
  return count > 1 ? `spawn · ${count} blocks` : "spawn";
}

function JobDetail({ row, eventsSince }: { row: CronRow; eventsSince: string | null }) {
  const blocks = row.trigger?.action.kind === "spawn" ? row.trigger.action.blocks : [];
  return (
    <div className="flex flex-col gap-4 border-l-2 border-[var(--color-accent)] pb-3 pl-[11px] pr-[13px] pt-3">
      <section className={SECTION_CLASS}>
        <h3 className={SECTION_HEADING_CLASS}>Settings</h3>
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1">
          <Setting label="Cron">{row.source.schedule}</Setting>
          <Setting label="Run on start">{row.source.runOnStart ? "yes" : "no"}</Setting>
          <Setting label="Action">{actionSummary(row)}</Setting>
          {blocks.map((block, index) => (
            <BlockSettings
              block={block}
              key={index}
              label={blocks.length > 1 ? `Block ${index + 1}` : null}
            />
          ))}
        </dl>
      </section>
      <section className={SECTION_CLASS}>
        <h3 className={SECTION_HEADING_CLASS}>Recent runs</h3>
        {row.runs.length === 0 ? (
          <span className={SECONDARY_TEXT}>{noTickText(eventsSince)}</span>
        ) : (
          <ul className="flex flex-col gap-2 sm:gap-1">
            {row.runs.map((run, index) => (
              <li className="flex flex-col sm:flex-row sm:gap-3" key={index}>
                <span
                  className={`shrink-0 tabular-nums ${SECONDARY_TEXT}`}
                  title={formatAbsoluteTime(run.at)}
                >
                  {formatShortTimestamp(run.at)}
                </span>
                <RunEntry projectId={row.projectId} run={run} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunEntry({ run, projectId }: { run: CronRun; projectId: string }) {
  if (run.kind === "tick") return <span className={PRIMARY_TEXT}>Cron tick</span>;
  return <RunText action={run.action} projectId={projectId} />;
}

function BlockSettings({ block, label }: { block: CronSpawnBlockView; label: string | null }) {
  return (
    <>
      {label ? <dt className={`col-span-2 pt-1 ${SECTION_HEADING_CLASS}`}>{label}</dt> : null}
      <Setting label="Agent">{block.agent ?? "default"}</Setting>
      <Setting label="Model">{block.model ?? "default"}</Setting>
      <Setting label="Effort">{block.reasoningEffort ?? "default"}</Setting>
      {block.mode ? <Setting label="Mode">{block.mode}</Setting> : null}
      <Setting label="Prompt">
        <span
          className="line-clamp-6 whitespace-pre-wrap [overflow-wrap:anywhere]"
          title={block.prompt}
        >
          {block.prompt}
        </span>
      </Setting>
    </>
  );
}

function JobRow({
  row,
  eventsSince,
  open,
  onToggle,
}: {
  row: CronRow;
  eventsSince: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const marker = DISK_MARKER_TITLE[row.disk];
  const tickTitle = row.lastTick ? formatAbsoluteTime(row.lastTick) : noTickText(eventsSince);
  const tickText = row.lastTick ? formatRelativeTime(row.lastTick) : "—";
  return (
    <div className="border-b border-[var(--color-border-subtle)]">
      {/* Mouse convenience only: the keyboard toggle is the native button below. */}
      <div
        className={`${GRID_CLASS} w-full cursor-pointer items-baseline px-[13px] py-2.5 text-left transition focus-within:bg-[var(--color-row-hover)] hover:bg-[var(--color-row-hover)] ${open ? "bg-[var(--color-row-hover)]" : ""}`}
        onClick={onToggle}
      >
        <button
          aria-expanded={open}
          className="group flex min-w-0 flex-col text-left outline-none"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          type="button"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={`truncate font-semibold ${PRIMARY_TEXT} underline-offset-2 group-focus-visible:text-[var(--color-accent)] group-focus-visible:underline`}
            >
              {row.name}
            </span>
            {marker ? (
              <span className={`shrink-0 ${ATTENTION_TEXT}`} title={marker}>
                •
              </span>
            ) : null}
          </span>
          {row.subtitle ? (
            <span className={`truncate ${SECONDARY_TEXT}`}>{row.subtitle}</span>
          ) : null}
        </button>
        <span className={`hidden truncate sm:inline ${SECONDARY_TEXT}`}>{row.source.schedule}</span>
        <span className={`hidden tabular-nums sm:inline ${SECONDARY_TEXT}`} title={tickTitle}>
          {tickText}
        </span>
        <span className="flex min-w-0 justify-end sm:justify-start">
          <ActionCell row={row} />
        </span>
        <span className={`col-span-2 truncate sm:hidden ${SECONDARY_TEXT}`} title={tickTitle}>
          {row.source.schedule} · {tickText}
        </span>
      </div>
      {open ? <JobDetail eventsSince={eventsSince} row={row} /> : null}
    </div>
  );
}

function JobList({ data, allProjects }: { data: CronJobsResponse; allProjects: boolean }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rows = buildCronRows(data, allProjects);
  if (rows.length === 0) {
    return <div className={`px-[13px] py-6 text-center ${SECONDARY_TEXT}`}>No cron jobs</div>;
  }
  const drift = data.projects
    .map((project) => ({ project, line: driftLine(project, allProjects) }))
    .filter((entry) => entry.line !== null);
  return (
    <>
      {drift.map(({ project, line }) => (
        <div
          className="border-b border-[var(--color-border-subtle)] px-[13px] py-1.5"
          key={project.projectId}
        >
          {line}
        </div>
      ))}
      <div
        className={`${GRID_CLASS} hidden border-b border-[var(--color-border-default)] px-[13px] py-1.5 sm:grid`}
      >
        <span className={LABEL_CLASS}>Job</span>
        <span className={LABEL_CLASS}>Schedule</span>
        <span className={LABEL_CLASS}>Last tick</span>
        <span className={LABEL_CLASS}>Last action</span>
      </div>
      {rows.map((row) => (
        <JobRow
          eventsSince={data.eventsSince}
          key={row.key}
          onToggle={() => setOpenKey((current) => (current === row.key ? null : row.key))}
          open={openKey === row.key}
          row={row}
        />
      ))}
    </>
  );
}

export function CronJobsModal({
  projects,
  initialProjectId,
  onClose,
}: {
  projects: readonly ProjectInfo[];
  initialProjectId: string;
  onClose: () => void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const [state, setState] = useState<LoadState>({ status: "pending" });
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "pending" });
    fetchCronJobs(projectId, controller.signal).then(
      (data) => setState({ status: "ready", data }),
      () => {
        if (!controller.signal.aborted) setState({ status: "error" });
      },
    );
    return () => controller.abort();
  }, [projectId]);

  return (
    <div
      aria-labelledby="cron-modal-title"
      aria-modal="true"
      className="fixed inset-0 z-[85] flex items-start justify-center bg-[var(--color-modal-backdrop)] px-4 pb-4 pt-[max(2.75rem,calc(var(--safe-top)_+_0.75rem))]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div className="flex max-h-[80vh] w-[min(640px,100%)] flex-col border border-[var(--color-border-strong)] bg-[var(--color-bg-base)]">
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border-default)] px-[13px] py-2">
          <h2
            className={`font-bold uppercase tracking-[0.1em] ${PRIMARY_TEXT}`}
            id="cron-modal-title"
          >
            Cron
          </h2>
          <select
            aria-label="Cron project"
            className="h-7 min-w-0 border border-[var(--color-input-border)] bg-[var(--color-input-bg)] px-2 text-[var(--color-input-text)] outline-none transition focus:border-[var(--color-accent)] focus-visible:border-[var(--color-accent)]"
            onChange={(event) => setProjectId(event.target.value)}
            ref={selectRef}
            value={projectId}
          >
            <option value="">All Projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <span className="flex-1" />
          <button
            aria-label="Close cron"
            className={`uppercase ${SECONDARY_TEXT} outline-none transition underline-offset-2 hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-accent)] focus-visible:underline`}
            onClick={onClose}
            type="button"
          >
            esc
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {state.status === "ready" ? (
            <JobList allProjects={projectId === ""} data={state.data} key={projectId} />
          ) : state.status === "pending" ? (
            <CenteredLoader className="py-6" label="Loading cron jobs" />
          ) : (
            <div className={`px-[13px] py-6 text-center ${ERROR_TEXT}`}>
              Could not load cron jobs
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

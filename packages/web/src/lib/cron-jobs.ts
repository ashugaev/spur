import type {
  CronActionEvent,
  CronDiskState,
  CronJobEditDraft,
  CronJobEditResult,
  CronJobEditUpdate,
  CronJobsResponse,
  CronSourceView,
  CronTriggerView,
} from "@/lib/types";

const RECENT_RUNS_LIMIT = 10;

export type CronRun =
  | { kind: "tick"; at: string }
  | { kind: "action"; at: string; action: CronActionEvent };

export interface CronRow {
  key: string;
  projectId: string;
  name: string;
  subtitle: string | null;
  disk: CronDiskState;
  source: CronSourceView;
  trigger: CronTriggerView | null;
  lastTick: string | null;
  lastAction: CronActionEvent | null;
  runs: CronRun[];
}

export async function fetchCronJobs(
  projectId: string,
  signal: AbortSignal,
): Promise<CronJobsResponse> {
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  const response = await fetch(`/api/cron${query}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Cron jobs request failed: ${response.status}`);
  return (await response.json()) as CronJobsResponse;
}

export type CronJobEditIdentity = Pick<CronJobEditDraft, "projectId" | "sourceId" | "triggerId">;

export class CronJobEditRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

function editUrl(identity: CronJobEditIdentity): string {
  return `/api/cron/edit?${new URLSearchParams({
    project: identity.projectId,
    source: identity.sourceId,
    trigger: identity.triggerId,
  })}`;
}

async function editResponse<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = payload as { error?: unknown; field?: unknown } | null;
    throw new CronJobEditRequestError(
      response.status,
      typeof error?.error === "string" ? error.error : "Could not edit cron job.",
      typeof error?.field === "string" ? error.field : undefined,
    );
  }
  return payload as T;
}

export async function fetchCronJobDraft(
  identity: CronJobEditIdentity,
  signal: AbortSignal,
): Promise<CronJobEditDraft> {
  return editResponse(await fetch(editUrl(identity), { cache: "no-store", signal }));
}

export async function saveCronJobDraft(
  identity: CronJobEditIdentity,
  update: CronJobEditUpdate,
): Promise<CronJobEditResult> {
  return editResponse(
    await fetch(editUrl(identity), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
}

function mergeRuns(source: CronSourceView, trigger: CronTriggerView | null): CronRun[] {
  const runs: CronRun[] = [
    ...source.recentTicks.map((at): CronRun => ({ kind: "tick", at })),
    ...(trigger?.recentActions ?? []).map(
      (action): CronRun => ({ kind: "action", at: action.at, action }),
    ),
  ];
  return runs
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, RECENT_RUNS_LIMIT);
}

// One row per trigger; a source without a trigger gets one source-only row.
export function buildCronRows(response: CronJobsResponse, allProjects: boolean): CronRow[] {
  const rows: CronRow[] = [];
  for (const project of response.projects) {
    for (const source of project.sources) {
      const triggers: (CronTriggerView | null)[] =
        source.triggers.length > 0 ? source.triggers : [null];
      for (const trigger of triggers) {
        const name = trigger?.triggerId ?? source.sourceId;
        const subtitle = [
          allProjects ? project.projectName : null,
          name !== source.sourceId ? source.sourceId : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" · ");
        rows.push({
          key: `${project.projectId}/${source.sourceId}/${trigger?.triggerId ?? ""}`,
          projectId: project.projectId,
          name,
          subtitle: subtitle || null,
          disk: trigger && trigger.disk !== "same" ? trigger.disk : source.disk,
          source,
          trigger,
          lastTick: source.recentTicks[0] ?? null,
          lastAction: trigger?.recentActions[0] ?? null,
          runs: mergeRuns(source, trigger),
        });
      }
    }
  }
  return rows;
}

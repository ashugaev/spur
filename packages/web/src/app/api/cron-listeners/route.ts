import { type NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import type { CronListenerView, CronListenersSnapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const filterProjectId = searchParams.get("projectId");

  try {
    const { config } = await getServices();
    const jobs: CronListenerView[] = [];

    for (const [projectId, project] of Object.entries(config.projects)) {
      if (filterProjectId && projectId !== filterProjectId) continue;
      const listeners = project.listeners ?? {};
      for (const [listenerId, listener] of Object.entries(listeners)) {
        if (listener.source !== "cron") continue;
        const trigger = listener.trigger as Record<string, unknown> | undefined;
        const skill = typeof trigger?.skill === "string" && trigger.skill.length > 0
          ? trigger.skill
          : undefined;
        const prompt = skill
          ? `/${skill}`
          : typeof trigger?.prompt === "string" ? trigger.prompt : "";
        if (!prompt) continue; // skip invalid cron listeners (no skill or prompt)
        jobs.push({
          listenerId,
          projectId,
          projectName: project.name ?? projectId,
          intervalMs:
            typeof listener.intervalMs === "number" ? listener.intervalMs : 60_000,
          skill,
          prompt,
          agent: typeof trigger?.agent === "string" ? trigger.agent : undefined,
          branch: typeof trigger?.branch === "string" ? trigger.branch : undefined,
          runOnStart: listener.runOnStart === true,
          health: "unknown",
        });
      }
    }

    const snapshot: CronListenersSnapshot = {
      projectId: filterProjectId,
      jobs,
      fetchedAt: new Date().toISOString(),
    };
    return NextResponse.json(snapshot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

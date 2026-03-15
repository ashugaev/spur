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

      const triggers = project.triggers ?? {};
      for (const [triggerId, trigger] of Object.entries(triggers)) {
        if (trigger.event !== "cron:tick") continue;
        const spawn = trigger.spawn;
        const skill =
          typeof spawn?.skill === "string" && spawn.skill.length > 0
            ? spawn.skill
            : undefined;
        const prompt = skill
          ? `/${skill}`
          : typeof spawn?.prompt === "string"
            ? spawn.prompt
            : "";
        if (!prompt) continue;
        jobs.push({
          listenerId: triggerId,
          projectId,
          projectName: project.name ?? projectId,
          schedule: trigger.schedule,
          skill,
          prompt,
          agent: typeof spawn?.agent === "string" ? spawn.agent : undefined,
          branch: typeof spawn?.branch === "string" ? spawn.branch : undefined,
          runOnStart: trigger.runOnStart === true,
          health: "unknown",
          source: "trigger",
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

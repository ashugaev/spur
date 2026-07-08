import type { Metadata } from "next";
import { SessionDetail } from "@/components/SessionDetail";
import { getSessionTitle } from "@/lib/format";
import { decodeRouteParam } from "@/lib/project-routes";
import { spurRequestJson } from "@/lib/spur-daemon";
import { toDashboardSession, type SpurSessionView } from "@/lib/types";

export const dynamic = "force-dynamic";

interface SessionPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ project?: string }>;
}

export async function generateMetadata({
  params,
}: Pick<SessionPageProps, "params">): Promise<Metadata> {
  const resolvedParams = await params;
  const sessionId = decodeRouteParam(resolvedParams.id);

  try {
    const payload = await spurRequestJson<SpurSessionView>(
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    return { title: getSessionTitle(toDashboardSession(payload)) };
  } catch {
    return { title: sessionId };
  }
}

export default async function SessionPage({ params, searchParams }: SessionPageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;
  const sessionId = decodeRouteParam(resolvedParams.id);
  const projectId = resolvedSearchParams.project?.trim();

  return <SessionDetail projectId={projectId} sessionId={sessionId} />;
}
